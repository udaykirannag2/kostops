#!/usr/bin/env python3
"""
deploy_agent.py
---------------
Packages the KostOps Strands agent and deploys it to Bedrock AgentCore Runtime.

Run this AFTER `cdk deploy --all` because it reads configuration that CDK
stored in SSM Parameter Store (/kostops/agentcore-config).

Usage:
    python scripts/deploy_agent.py

What it does:
  1. Reads agent config from SSM (/kostops/agentcore-config)
  2. Zips the agents/ directory (visibility_agent.py + tools/ + mcp/)
  3. Uploads the zip to S3 (uses the Athena results bucket as staging)
  4. Creates or updates the AgentCore Runtime deployment
  5. Waits for the deployment to reach ACTIVE state
  6. Prints the endpoint URL

Requirements:
  - AWS credentials with bedrock-agentcore:* and s3:PutObject permissions
  - uv installed (for the MCP server sidecars)
  - Run from the repo root directory
"""

import os
import sys
import json
import time
import zipfile
import tempfile
import logging
import boto3
import pathlib

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

AWS_REGION    = os.environ.get('AWS_REGION', 'us-east-1')
SSM_PARAM     = '/kostops/agentcore-config'
AGENT_DIR     = pathlib.Path(__file__).parent.parent  # repo root

# Files/dirs to include in the agent zip
AGENT_SOURCES = ['visibility_agent.py', 'payer_role.py', 'tools/', 'mcp/']

_ssm     = boto3.client('ssm',     region_name=AWS_REGION)
_s3      = boto3.client('s3',      region_name=AWS_REGION)
_bedrock = boto3.client('bedrock', region_name=AWS_REGION)


# ── Step 1: Read config from SSM ──────────────────────────────────────────────

def load_agent_config() -> dict:
    logger.info(f"Reading agent config from SSM: {SSM_PARAM}")
    response = _ssm.get_parameter(Name=SSM_PARAM)
    config   = json.loads(response['Parameter']['Value'])
    logger.info(f"Agent config loaded: {config['agentName']}")
    return config


# ── Step 2: Zip the agent code ────────────────────────────────────────────────

def zip_agent_code() -> str:
    """
    Zip visibility_agent.py, payer_role.py, tools/, and agent_mcp_config.json
    into a temporary zip file. Returns the path to the zip.
    """
    tmp      = tempfile.NamedTemporaryFile(suffix='.zip', delete=False)
    zip_path = tmp.name
    tmp.close()

    logger.info(f"Zipping agent code to {zip_path}")

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for source in AGENT_SOURCES:
            source_path = AGENT_DIR / source
            if source_path.is_file():
                zf.write(source_path, source)
                logger.info(f"  + {source}")
            elif source_path.is_dir():
                for file in source_path.rglob('*'):
                    if file.is_file() and '__pycache__' not in str(file):
                        arcname = str(file.relative_to(AGENT_DIR))
                        zf.write(file, arcname)
                        logger.info(f"  + {arcname}")
            else:
                logger.warning(f"  ! {source} not found — skipping")

    size_kb = os.path.getsize(zip_path) / 1024
    logger.info(f"Agent zip created: {size_kb:.1f} KB")
    return zip_path


# ── Step 3: Upload zip to S3 ──────────────────────────────────────────────────

def upload_zip(zip_path: str, bucket_name: str, agent_name: str) -> str:
    """Upload the agent zip to S3 and return the S3 URI."""
    s3_key = f"agentcore-deployments/{agent_name}/agent.zip"
    logger.info(f"Uploading zip to s3://{bucket_name}/{s3_key}")
    _s3.upload_file(zip_path, bucket_name, s3_key)
    s3_uri = f"s3://{bucket_name}/{s3_key}"
    logger.info(f"Uploaded: {s3_uri}")
    return s3_uri


# ── Step 4: Create or update AgentCore Runtime deployment ─────────────────────

def deploy_to_agentcore(config: dict, s3_uri: str) -> str:
    """
    Create or update the AgentCore Runtime deployment.
    Returns the endpoint URL.
    """
    agent_name = config['agentName']

    deployment_config = {
        'agentName':   agent_name,
        'roleArn':     config['roleArn'],
        'codeSource':  {'s3': {'uri': s3_uri}},
        'runtime': {
            'entrypoint':      config['entrypoint'],
            'memoryMb':        config['memoryMb'],
            'timeoutSeconds':  config['timeoutSeconds'],
        },
        'environmentVariables': config['environmentVariables'],
        'mcpConfig': {
            'configPath': config['mcpConfigPath'],
        },
    }

    # Check if deployment already exists
    try:
        existing = _bedrock.get_agent_runtime(agentName=agent_name)
        logger.info(f"Updating existing AgentCore deployment: {agent_name}")
        response = _bedrock.update_agent_runtime(
            agentName=agent_name,
            **{k: v for k, v in deployment_config.items() if k != 'agentName'},
        )
    except _bedrock.exceptions.ResourceNotFoundException:
        logger.info(f"Creating new AgentCore deployment: {agent_name}")
        response = _bedrock.create_agent_runtime(**deployment_config)

    return response.get('endpointUrl', '')


# ── Step 5: Wait for ACTIVE state ─────────────────────────────────────────────

def wait_for_active(agent_name: str, timeout_seconds: int = 300) -> str:
    """Poll AgentCore until the deployment is ACTIVE. Returns endpoint URL."""
    logger.info(f"Waiting for {agent_name} to become ACTIVE...")
    deadline = time.time() + timeout_seconds

    while time.time() < deadline:
        response    = _bedrock.get_agent_runtime(agentName=agent_name)
        status      = response.get('status', '')
        endpoint    = response.get('endpointUrl', '')

        logger.info(f"  Status: {status}")

        if status == 'ACTIVE':
            logger.info(f"Deployment ACTIVE: {endpoint}")
            return endpoint

        if status in ('FAILED', 'ERROR'):
            reason = response.get('failureReason', 'unknown')
            raise RuntimeError(f"AgentCore deployment failed: {reason}")

        time.sleep(15)

    raise TimeoutError(f"AgentCore deployment did not become ACTIVE within {timeout_seconds}s")


# ── Step 6: Update SSM with final endpoint URL ────────────────────────────────

def update_endpoint_ssm(endpoint_url: str) -> None:
    """Store the final endpoint URL in SSM so other stacks can read it."""
    _ssm.put_parameter(
        Name='/kostops/agent-endpoint-url',
        Value=endpoint_url,
        Type='String',
        Overwrite=True,
        Description='KostOps AgentCore Runtime endpoint URL',
    )
    logger.info(f"Endpoint URL saved to SSM: /kostops/agent-endpoint-url")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    logger.info("=== KostOps AgentCore Deployment ===")

    config   = load_agent_config()
    zip_path = zip_agent_code()

    # Use the Athena results bucket as staging — it already exists and the
    # agent role has write access to it
    athena_bucket = f"kostops-athena-results-{boto3.client('sts').get_caller_identity()['Account']}"

    try:
        s3_uri       = upload_zip(zip_path, athena_bucket, config['agentName'])
        endpoint_url = deploy_to_agentcore(config, s3_uri)
        endpoint_url = wait_for_active(config['agentName'])
        update_endpoint_ssm(endpoint_url)
    finally:
        os.unlink(zip_path)

    print("\n" + "=" * 60)
    print(f"  KostOps agent deployed successfully!")
    print(f"  Endpoint: {endpoint_url}")
    print("=" * 60 + "\n")
    print("Next step: open the CloudFront URL from CDK outputs and log in.")


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        logger.error(f"Deployment failed: {e}")
        sys.exit(1)
