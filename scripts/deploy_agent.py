#!/usr/bin/env python3
"""
deploy_agent.py  — MANUAL FALLBACK ONLY
-----------------------------------------
Normally you do NOT need to run this script.
`cdk deploy --all` handles agent deployment automatically via the
KostOpsAgentStack Custom Resource (lambda/agentcore_deploy.py).

Use this script only when:
  • You want to re-deploy the agent without a full CDK deploy
  • You are debugging AgentCore Runtime issues outside of CDK
  • CDK Custom Resource failed and you need to recover manually

Usage:
    python scripts/deploy_agent.py

Pre-requisites:
  • `cdk deploy --all` has been run at least once (SSM config must exist)
  • AWS credentials with bedrock-agentcore-control:* and s3:PutObject permissions
  • Run from the repo root directory
"""

import os
import sys
import json
import time
import zipfile
import tempfile
import logging
import subprocess
import shutil
import boto3
import pathlib
from typing import Optional, Tuple

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

AWS_REGION    = os.environ.get('AWS_REGION', 'us-east-1')
SSM_PARAM     = '/kostops/agentcore-config'
AGENT_DIR     = pathlib.Path(__file__).parent.parent  # repo root

AGENT_SOURCES = [
    'visibility_agent.py',
    'payer_role.py',
    'tools/',
    'mcp/',
    'strands/',   # lightweight stub — replaces strands-agents (eliminates pydantic_core Rust .so)
]

_ssm   = boto3.client('ssm',                       region_name=AWS_REGION)
_s3    = boto3.client('s3',                        region_name=AWS_REGION)
_ctrl  = boto3.client('bedrock-agentcore-control', region_name=AWS_REGION)
_lam   = boto3.client('lambda',                    region_name=AWS_REGION)


# ── Step 1: Read config from SSM ──────────────────────────────────────────────

def load_agent_config() -> dict:
    logger.info(f"Reading agent config from SSM: {SSM_PARAM}")
    response = _ssm.get_parameter(Name=SSM_PARAM)
    config   = json.loads(response['Parameter']['Value'])
    logger.info(f"Agent config loaded: {config['agentName']}")
    return config


# ── Step 2: Zip the agent code (with bundled dependencies) ───────────────────

def zip_agent_code() -> str:
    """
    Build a self-contained zip:
      1. pip-install strands-agents + bedrock-agentcore into a temp build dir
         using Linux/Python-3.12 compatible wheels (so they run inside AgentCore)
      2. Copy the agent source files on top
      3. Zip the whole build dir
    """
    build_dir = tempfile.mkdtemp(prefix='kostops-agent-build-')
    try:
        logger.info(f"Installing agent dependencies to {build_dir} ...")
        # Install boto3 only — pure Python, no Rust .so, no platform concerns.
        #
        # WHY NOT bedrock-agentcore?
        #   bedrock-agentcore → pydantic → pydantic_core (4.1 MB ARM64 Rust .so)
        #   dlopen() of pydantic_core in AgentCore cold containers exceeds the
        #   30-second initialization timeout on every invocation.
        #
        # SOLUTION: replaced BedrockAgentCoreApp with stdlib http.server (see
        #   visibility_agent.py). This starts in < 100ms with zero .so files.
        #   boto3 (pure Python) is still needed for Bedrock converse() + tools.
        #
        # boto3 is pure Python (no binary wheels) so --platform / --only-binary
        # are not needed. AgentCore Runtime Python 3.12 does NOT pre-install it.
        subprocess.check_call([
            sys.executable, '-m', 'pip', 'install',
            '--target', build_dir,
            '--quiet',
            'boto3',
        ])
        logger.info("Dependencies installed")

        # We ship boto3 + all its pure-Python deps in the zip.
        # AgentCore Runtime does NOT pre-install boto3 (it's not Lambda).
        # Nothing needs to be removed — all installed packages are required.
        # (Previously we removed boto3/botocore here when using bedrock-agentcore,
        #  assuming they were pre-installed like in Lambda. That assumption was wrong.)
        RUNTIME_PROVIDED: list = []
        removed_mb = 0.0
        for pkg in RUNTIME_PROVIDED:
            for candidate in [pkg, pkg.replace('-', '_')]:
                for entry in [
                    os.path.join(build_dir, candidate),
                    # also .dist-info dirs like botocore-1.x.x.dist-info
                ]:
                    if os.path.isdir(entry):
                        size = sum(
                            os.path.getsize(os.path.join(r, f))
                            for r, _, files in os.walk(entry) for f in files
                        ) / (1024 * 1024)
                        shutil.rmtree(entry)
                        removed_mb += size
                        logger.info(f"  - removed pre-installed pkg: {candidate} ({size:.1f} MB)")

        if removed_mb > 0:
            logger.info(f"Removed {removed_mb:.1f} MB of packages")

        # Copy agent source files on top of the installed packages
        for source in AGENT_SOURCES:
            source_path = AGENT_DIR / source
            if source_path.is_file():
                dest = os.path.join(build_dir, source)
                shutil.copy2(str(source_path), dest)
                logger.info(f"  + {source}")
            elif source_path.is_dir():
                dest_dir = os.path.join(build_dir, source)
                shutil.copytree(str(source_path), dest_dir, dirs_exist_ok=True)
                logger.info(f"  + {source}/ (directory)")
            else:
                logger.warning(f"  ! {source} not found — skipping")

        # Zip the build dir
        tmp      = tempfile.NamedTemporaryFile(suffix='.zip', delete=False)
        zip_path = tmp.name
        tmp.close()

        logger.info(f"Zipping build dir to {zip_path}")
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(build_dir):
                # Skip __pycache__ and .dist-info test dirs to keep zip lean
                dirs[:] = [
                    d for d in dirs
                    if '__pycache__' not in d and d != 'tests' and d != 'test'
                ]
                for file in files:
                    full_path = os.path.join(root, file)
                    arcname   = os.path.relpath(full_path, build_dir)
                    zf.write(full_path, arcname)

        size_mb = os.path.getsize(zip_path) / (1024 * 1024)
        logger.info(f"Agent zip created: {size_mb:.1f} MB")
        return zip_path

    finally:
        shutil.rmtree(build_dir, ignore_errors=True)


# ── Step 3: Upload zip to S3 ──────────────────────────────────────────────────

def upload_zip(zip_path: str, bucket_name: str, agent_name: str) -> Tuple[str, str]:
    """Upload the agent zip to S3. Returns (bucket, s3_key)."""
    s3_key = f"agentcore-deployments/{agent_name}/agent.zip"
    logger.info(f"Uploading zip to s3://{bucket_name}/{s3_key}")
    _s3.upload_file(zip_path, bucket_name, s3_key)
    logger.info(f"Uploaded: s3://{bucket_name}/{s3_key}")
    return bucket_name, s3_key


# ── Step 4: Find existing runtime by name ────────────────────────────────────

def find_runtime(name: str) -> Optional[dict]:
    paginator_token = None
    while True:
        kwargs = {}
        if paginator_token:
            kwargs['nextToken'] = paginator_token
        resp = _ctrl.list_agent_runtimes(**kwargs)
        for rt in resp.get('agentRuntimes', []):
            if rt.get('agentRuntimeName') == name:
                return rt
        paginator_token = resp.get('nextToken')
        if not paginator_token:
            return None


# ── Step 5: Create or update AgentCore Runtime ───────────────────────────────

def deploy_to_agentcore(config: dict, bucket: str, s3_key: str) -> Tuple[str, str]:
    """
    Create or update the AgentCore Runtime.
    Returns (agentRuntimeId, agentRuntimeArn).
    """
    agent_name = config['agentName']

    artifact = {
        'codeConfiguration': {
            'code': {
                's3': {
                    'bucket': bucket,
                    'prefix': s3_key,
                }
            },
            'runtime':    'PYTHON_3_12',
            'entryPoint': ['visibility_agent.py'],
        }
    }

    network = {'networkMode': 'PUBLIC'}

    lifecycle = {
        'idleRuntimeSessionTimeout': 300,   # 5 min idle before session cleanup
        'maxLifetime':               3600,  # max 1 hour session lifetime
    }

    existing = find_runtime(agent_name)

    if existing:
        runtime_id = existing['agentRuntimeId']
        logger.info(f"Updating existing AgentCore Runtime: {agent_name} ({runtime_id})")
        resp = _ctrl.update_agent_runtime(
            agentRuntimeId=        runtime_id,
            agentRuntimeArtifact=  artifact,
            roleArn=               config['roleArn'],
            networkConfiguration=  network,
            lifecycleConfiguration=lifecycle,
            environmentVariables=  config['environmentVariables'],
        )
        return resp['agentRuntimeId'], resp['agentRuntimeArn']
    else:
        logger.info(f"Creating new AgentCore Runtime: {agent_name}")
        resp = _ctrl.create_agent_runtime(
            agentRuntimeName=      agent_name,
            agentRuntimeArtifact=  artifact,
            roleArn=               config['roleArn'],
            networkConfiguration=  network,
            lifecycleConfiguration=lifecycle,
            environmentVariables=  config['environmentVariables'],
        )
        return resp['agentRuntimeId'], resp['agentRuntimeArn']


# ── Step 6: Wait for ACTIVE ───────────────────────────────────────────────────

def wait_for_active(runtime_id: str, timeout_seconds: int = 600) -> None:
    logger.info(f"Waiting for runtime {runtime_id} to become ACTIVE...")
    deadline = time.time() + timeout_seconds

    while time.time() < deadline:
        resp   = _ctrl.get_agent_runtime(agentRuntimeId=runtime_id)
        status = resp.get('status', '')
        logger.info(f"  Status: {status}")

        if status in ('ACTIVE', 'READY'):
            logger.info(f"Runtime is {status} (operational)")
            return

        if status in ('FAILED', 'CREATE_FAILED', 'UPDATE_FAILED'):
            reason = resp.get('failureReason', 'unknown')
            raise RuntimeError(f"AgentCore Runtime failed: {reason}")

        time.sleep(15)

    raise TimeoutError(f"Runtime did not become ACTIVE within {timeout_seconds}s")


# ── Step 7: Save ARN to SSM + update Lambda env var ──────────────────────────

def update_references(runtime_arn: str) -> None:
    """Store runtime ARN in SSM and update the chat-handler Lambda env var."""
    _ssm.put_parameter(
        Name='/kostops/agent-runtime-arn',
        Value=runtime_arn,
        Type='String',
        Overwrite=True,
        Description='KostOps AgentCore Runtime ARN',
    )
    logger.info("Runtime ARN saved to SSM: /kostops/agent-runtime-arn")

    # Update the chat-handler Lambda so it uses the real ARN right away
    try:
        lam_resp = _lam.get_function_configuration(FunctionName='kostops-chat-handler')
        current_env = lam_resp.get('Environment', {}).get('Variables', {})
        current_env['AGENT_RUNTIME_ARN'] = runtime_arn
        _lam.update_function_configuration(
            FunctionName='kostops-chat-handler',
            Environment={'Variables': current_env},
        )
        logger.info("chat-handler Lambda env var AGENT_RUNTIME_ARN updated")
    except Exception as e:
        logger.warning(f"Could not update Lambda env var (non-fatal): {e}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    logger.info("=== KostOps AgentCore Deployment ===")

    config       = load_agent_config()
    zip_path     = zip_agent_code()
    account_id   = boto3.client('sts', region_name=AWS_REGION).get_caller_identity()['Account']
    athena_bucket = f"kostops-athena-results-{account_id}"

    try:
        bucket, s3_key   = upload_zip(zip_path, athena_bucket, config['agentName'])
        runtime_id, arn  = deploy_to_agentcore(config, bucket, s3_key)
        wait_for_active(runtime_id)
        update_references(arn)
    finally:
        os.unlink(zip_path)

    print("\n" + "=" * 60)
    print(f"  KostOps agent deployed successfully!")
    print(f"  Runtime ARN: {arn}")
    print("=" * 60 + "\n")
    print("Next step: open the CloudFront URL from CDK outputs and log in.")


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        logger.error(f"Deployment failed: {e}")
        sys.exit(1)
