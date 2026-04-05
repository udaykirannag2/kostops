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

The Lambda signs the AgentCore request with its IAM role credentials
(SigV4) — the browser never touches AWS credentials directly.
"""

import os
import json
import uuid
import logging
import boto3
from botocore.auth    import SigV4Auth
from botocore.awsrequest import AWSRequest
import urllib.request

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

AGENT_ENDPOINT_URL = os.environ['AGENT_ENDPOINT_URL']
AWS_REGION         = os.environ.get('AWS_REGION', 'us-east-1')

_session     = boto3.Session()
_credentials = _session.get_credentials()


def _signed_post(url: str, body: dict) -> dict:
    """
    POST to an AgentCore Runtime endpoint with SigV4 request signing.
    AgentCore uses the 'bedrock' service namespace for signing.
    """
    payload      = json.dumps(body).encode('utf-8')
    aws_request  = AWSRequest(method='POST', url=url, data=payload,
                              headers={'Content-Type': 'application/json'})

    SigV4Auth(_credentials.resolve(), 'bedrock', AWS_REGION).add_auth(aws_request)

    req = urllib.request.Request(
        url,
        data=payload,
        headers=dict(aws_request.headers),
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=290) as resp:
        return json.loads(resp.read().decode('utf-8'))


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
        body      = json.loads(event.get('body') or '{}')
        message   = body.get('message', '').strip()
        session_id = body.get('sessionId') or str(uuid.uuid4())
    except (json.JSONDecodeError, KeyError) as e:
        return _cors_response(400, {'error': f'Invalid request body: {e}'})

    if not message:
        return _cors_response(400, {'error': 'message is required'})

    logger.info(f"Chat request | session={session_id} | message_len={len(message)}")

    # Forward to AgentCore Runtime
    try:
        agent_response = _signed_post(
            url=AGENT_ENDPOINT_URL,
            body={
                'inputText': message,
                'sessionId': session_id,
            },
        )
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        logger.error(f"AgentCore error {e.code}: {error_body}")
        return _cors_response(502, {'error': 'Agent error', 'detail': error_body})
    except Exception as e:
        logger.error(f"Unexpected error calling AgentCore: {e}")
        return _cors_response(500, {'error': 'Internal error'})

    reply = (
        agent_response.get('output')
        or agent_response.get('completion')
        or agent_response.get('outputText')
        or str(agent_response)
    )

    logger.info(f"Chat reply | session={session_id} | reply_len={len(reply)}")
    return _cors_response(200, {'reply': reply, 'sessionId': session_id})
