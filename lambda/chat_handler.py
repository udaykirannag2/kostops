"""
Chat Handler
------------
Lambda function that proxies chat messages from the React UI
to the KostOps Strands agent running on Bedrock AgentCore Runtime.

Request  (POST /chat):
  {
    "message":   "What are my top savings opportunities?",
    "sessionId": "optional-uuid-to-continue-a-conversation"
  }

Response:
  {
    "reply":     "Your top 3 savings opportunities are...",
    "sessionId": "uuid-for-next-turn"
  }

AGENT_RUNTIME_ARN is set by scripts/deploy_agent.py after the
AgentCore Runtime is provisioned. The boto3 bedrock-agentcore client
handles request signing automatically.
"""

import os
import json
import uuid
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

AWS_REGION        = os.environ.get('AWS_REGION', 'us-east-1')
AGENT_RUNTIME_ARN = os.environ.get('AGENT_RUNTIME_ARN', '')

_agentcore = boto3.client('bedrock-agentcore', region_name=AWS_REGION)


def _cors_response(status_code: int, body: dict) -> dict:
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body),
    }


def handler(event: dict, context) -> dict:
    # Parse request body
    try:
        body       = json.loads(event.get('body') or '{}')
        message    = body.get('message', '').strip()
        session_id = body.get('sessionId') or str(uuid.uuid4())
    except (json.JSONDecodeError, KeyError) as e:
        return _cors_response(400, {'error': f'Invalid request body: {e}'})

    if not message:
        return _cors_response(400, {'error': 'message is required'})

    if not AGENT_RUNTIME_ARN:
        return _cors_response(503, {
            'error': 'Agent not deployed yet',
            'hint':  'Run: python scripts/deploy_agent.py',
        })

    logger.info(f"Chat request | session={session_id} | message_len={len(message)}")

    try:
        resp = _agentcore.invoke_agent_runtime(
            agentRuntimeArn=  AGENT_RUNTIME_ARN,
            runtimeSessionId= session_id,
            payload=          json.dumps({'inputText': message}).encode('utf-8'),
            contentType=      'application/json',
            accept=           'application/json',
        )

        # response is a StreamingBody — read it
        raw     = resp['response'].read()
        decoded = json.loads(raw.decode('utf-8'))

        reply = (
            decoded.get('output')
            or decoded.get('completion')
            or decoded.get('outputText')
            or decoded.get('text')
            or str(decoded)
        )

    except _agentcore.exceptions.ResourceNotFoundException:
        logger.error(f"AgentCore Runtime not found: {AGENT_RUNTIME_ARN}")
        return _cors_response(503, {
            'error': 'Agent runtime not found',
            'hint':  'Run: python scripts/deploy_agent.py',
        })
    except Exception as e:
        logger.error(f"AgentCore invocation error: {e}")
        return _cors_response(500, {'error': 'Agent invocation failed', 'detail': str(e)})

    logger.info(f"Chat reply | session={session_id} | reply_len={len(reply)}")
    return _cors_response(200, {'reply': reply, 'sessionId': session_id})
