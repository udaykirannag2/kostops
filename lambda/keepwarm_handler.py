"""
Keep-Warm Handler
-----------------
Pings the AgentCore Runtime every 5 minutes so the container stays alive
and customers never hit the 30-second cold-start initialization timeout.

Triggered by: EventBridge Scheduler (rate(5 minutes))
Also callable: POST /ping from the UI (for manual warm-up after deploy)
"""

import os
import json
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

AWS_REGION        = os.environ.get('AWS_REGION', 'us-east-1')
AGENT_RUNTIME_ARN = os.environ.get('AGENT_RUNTIME_ARN', '')

_agentcore = boto3.client('bedrock-agentcore', region_name=AWS_REGION)


def handler(event, context):
    if not AGENT_RUNTIME_ARN:
        logger.warning("AGENT_RUNTIME_ARN not set — skipping warm-up ping")
        return {'statusCode': 503, 'body': 'Agent not deployed'}

    logger.info(f"Pinging AgentCore Runtime: {AGENT_RUNTIME_ARN}")
    try:
        resp = _agentcore.invoke_agent_runtime(
            agentRuntimeArn=  AGENT_RUNTIME_ARN,
            runtimeSessionId= 'keepwarm-' + 'x' * 27,  # min 33 chars
            payload=          json.dumps({'inputText': '__ping__'}).encode(),
            contentType=      'application/json',
            accept=           'application/json',
        )
        raw    = resp['response'].read()
        logger.info(f"Ping response: {raw[:200]}")
        return {'statusCode': 200, 'body': 'warm'}
    except Exception as e:
        # Cold-start timeout on very first ping is expected — not an error
        logger.warning(f"Ping result (may be first cold-start): {e}")
        return {'statusCode': 200, 'body': f'ping attempted: {str(e)[:100]}'}
