"""
agentcore_deploy.py — CDK Custom Resource handler
--------------------------------------------------
Called automatically by `cdk deploy` via a CloudFormation Custom Resource.
Replaces the manual `python scripts/deploy_agent.py` step.

Lifecycle:
  Create  → create AgentCore Runtime, wait for ACTIVE, update SSM + Lambda env var
  Update  → update AgentCore Runtime (triggered when asset hash or config changes)
  Delete  → delete AgentCore Runtime (on cdk destroy)

CloudFormation properties received (from agent-stack.ts CustomResource):
  AgentName           — e.g. "kostopsVisibilityAgent"
  RoleArn             — IAM role for the AgentCore Runtime to assume
  S3Bucket            — CDK assets bucket containing the agent zip
  S3Key               — S3 key of the agent zip (set by CDK asset bundling)
  AssetHash           — CDK asset hash; changing this forces a re-deploy
  EnvFindingsTable    — DynamoDB table name
  EnvCurBucket        — Payer CUR S3 bucket
  EnvAthenaWorkgroup  — Athena workgroup
  EnvGlueDatabase     — Glue database
  EnvCurTable         — Glue table name
  EnvBedrockModelId   — Bedrock model ID
  EnvPayerAccountId   — Payer AWS account ID
  EnvPayerRole        — Payer cross-account role ARN
  EnvAthenaResultsBucket — Athena results bucket
"""

import os
import json
import time
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')

_ctrl = boto3.client('bedrock-agentcore-control', region_name=AWS_REGION)
_ssm  = boto3.client('ssm',                       region_name=AWS_REGION)
_lam  = boto3.client('lambda',                    region_name=AWS_REGION)


# ── Entry point ───────────────────────────────────────────────────────────────

def handler(event, context):
    logger.info(f"Custom resource event: {json.dumps(event, default=str)}")

    request_type = event['RequestType']   # Create | Update | Delete
    props        = event['ResourceProperties']

    if request_type == 'Delete':
        return _handle_delete(props)
    else:
        return _handle_create_or_update(props)


# ── Create / Update ───────────────────────────────────────────────────────────

def _handle_create_or_update(props: dict) -> dict:
    agent_name = props['AgentName']
    role_arn   = props['RoleArn']
    bucket     = props['S3Bucket']
    s3_key     = props['S3Key']

    # Reconstruct environment variables from flat CFN properties
    env_vars = {
        'FINDINGS_TABLE':           props.get('EnvFindingsTable',       ''),
        'CUR_BUCKET':               props.get('EnvCurBucket',           ''),
        'ATHENA_WORKGROUP':         props.get('EnvAthenaWorkgroup',      'kostops-workgroup'),
        'ATHENA_RESULTS_BUCKET':    props.get('EnvAthenaResultsBucket',  ''),
        'GLUE_DATABASE':            props.get('EnvGlueDatabase',         'kostops_cur'),
        'CUR_TABLE':                props.get('EnvCurTable',             'data'),
        'BEDROCK_MODEL_ID':         props.get('EnvBedrockModelId',
                                              'anthropic.claude-sonnet-4-5-20250929-v1:0'),
        'PAYER_ACCOUNT_ID':         props.get('EnvPayerAccountId',       ''),
        'PAYER_CROSS_ACCOUNT_ROLE': props.get('EnvPayerRole',            ''),
    }
    # Strip empty values — AgentCore rejects empty strings in env vars
    env_vars = {k: v for k, v in env_vars.items() if v}

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
    network   = {'networkMode': 'PUBLIC'}
    lifecycle = {
        'idleRuntimeSessionTimeout': 300,   # 5 min idle → container cleanup
        'maxLifetime':               3600,  # 1 hour max session
    }

    existing = _find_runtime(agent_name)

    if existing:
        runtime_id = existing['agentRuntimeId']
        logger.info(f"Updating AgentCore Runtime: {agent_name} ({runtime_id})")
        resp = _ctrl.update_agent_runtime(
            agentRuntimeId=         runtime_id,
            agentRuntimeArtifact=   artifact,
            roleArn=                role_arn,
            networkConfiguration=   network,
            lifecycleConfiguration= lifecycle,
            environmentVariables=   env_vars,
        )
    else:
        logger.info(f"Creating AgentCore Runtime: {agent_name}")
        resp = _ctrl.create_agent_runtime(
            agentRuntimeName=       agent_name,
            agentRuntimeArtifact=   artifact,
            roleArn=                role_arn,
            networkConfiguration=   network,
            lifecycleConfiguration= lifecycle,
            environmentVariables=   env_vars,
        )

    runtime_id  = resp['agentRuntimeId']
    runtime_arn = resp['agentRuntimeArn']

    # Wait up to 12 minutes for ACTIVE (Lambda timeout is 15 min)
    logger.info(f"Waiting for ACTIVE status: {runtime_id}")
    _wait_for_active(runtime_id, timeout_seconds=720)

    # Persist the ARN so keepwarm Lambda and chat-handler can find it
    _ssm.put_parameter(
        Name        = '/kostops/agent-runtime-arn',
        Value       = runtime_arn,
        Type        = 'String',
        Overwrite   = True,
        Description = 'KostOps AgentCore Runtime ARN — written by CDK custom resource',
    )
    logger.info(f"Saved runtime ARN to SSM: /kostops/agent-runtime-arn")

    # Update the chat-handler Lambda so it picks up the new ARN immediately
    _update_chat_handler_arn(runtime_arn)

    logger.info(f"AgentCore Runtime deployed: {runtime_arn}")
    return {
        'PhysicalResourceId': runtime_id,
        'Data': {
            'RuntimeId':  runtime_id,
            'RuntimeArn': runtime_arn,
        },
    }


# ── Delete ────────────────────────────────────────────────────────────────────

def _handle_delete(props: dict) -> dict:
    agent_name = props['AgentName']
    logger.info(f"Deleting AgentCore Runtime: {agent_name}")
    try:
        existing = _find_runtime(agent_name)
        if existing:
            _ctrl.delete_agent_runtime(agentRuntimeId=existing['agentRuntimeId'])
            logger.info(f"Delete initiated for runtime: {existing['agentRuntimeId']}")
        else:
            logger.info("Runtime not found — nothing to delete")
    except Exception as e:
        # Non-fatal: let CDK stack deletion continue even if runtime is already gone
        logger.warning(f"Delete runtime failed (non-fatal): {e}")

    return {'PhysicalResourceId': props.get('AgentName', 'kostops-agent')}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _find_runtime(name: str) -> dict | None:
    """Find an existing AgentCore Runtime by name. Returns the runtime dict or None."""
    token = None
    while True:
        kwargs = {}
        if token:
            kwargs['nextToken'] = token
        resp  = _ctrl.list_agent_runtimes(**kwargs)
        for rt in resp.get('agentRuntimes', []):
            if rt.get('agentRuntimeName') == name:
                return rt
        token = resp.get('nextToken')
        if not token:
            return None


def _wait_for_active(runtime_id: str, timeout_seconds: int = 720) -> None:
    """Poll until the runtime reaches ACTIVE / READY status or times out."""
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        resp   = _ctrl.get_agent_runtime(agentRuntimeId=runtime_id)
        status = resp.get('status', '')
        logger.info(f"  Runtime status: {status}")

        if status in ('ACTIVE', 'READY'):
            logger.info(f"Runtime is {status}")
            return

        if 'FAIL' in status.upper():
            reason = resp.get('failureReason', 'unknown')
            raise RuntimeError(f"AgentCore Runtime failed: {reason}")

        time.sleep(15)

    raise TimeoutError(
        f"Runtime {runtime_id} did not reach ACTIVE within {timeout_seconds}s"
    )


def _update_chat_handler_arn(runtime_arn: str) -> None:
    """Update the chat-handler Lambda env var with the new runtime ARN."""
    try:
        lam_resp = _lam.get_function_configuration(FunctionName='kostops-chat-handler')
        env      = lam_resp.get('Environment', {}).get('Variables', {})
        env['AGENT_RUNTIME_ARN'] = runtime_arn
        _lam.update_function_configuration(
            FunctionName = 'kostops-chat-handler',
            Environment  = {'Variables': env},
        )
        logger.info("chat-handler Lambda AGENT_RUNTIME_ARN updated")
    except Exception as e:
        # Non-fatal — keepwarm will still work via SSM
        logger.warning(f"Could not update chat-handler env var: {e}")
