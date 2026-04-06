"""
Chat Handler
------------
Lambda function that proxies chat messages from the React UI
to the KostOps agent running on Bedrock AgentCore Runtime.

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

After each successful turn the handler upserts the conversation
to DynamoDB (kostops-conversations) so the UI can reload history
after a page refresh or on a different device.

AGENT_RUNTIME_ARN is set by scripts/deploy_agent.py after the
AgentCore Runtime is provisioned.
"""

import os
import json
import uuid
import logging
import time
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

AWS_REGION          = os.environ.get('AWS_REGION', 'us-east-1')
AGENT_RUNTIME_ARN   = os.environ.get('AGENT_RUNTIME_ARN', '')
CONVERSATIONS_TABLE = os.environ.get('CONVERSATIONS_TABLE', 'kostops-conversations')

# TTL: keep conversations for 30 days
CONVERSATION_TTL_DAYS = 30

_agentcore = boto3.client('bedrock-agentcore', region_name=AWS_REGION)
_ddb       = boto3.resource('dynamodb',        region_name=AWS_REGION)
_conv_table = _ddb.Table(CONVERSATIONS_TABLE)


def _cors_response(status_code: int, body: dict) -> dict:
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body),
    }


def _get_user_id(event: dict) -> str:
    """Extract Cognito sub from the API Gateway authorizer claims."""
    return (
        event.get('requestContext', {})
             .get('authorizer', {})
             .get('claims', {})
             .get('sub', 'anonymous')
    )


def _save_conversation(user_id: str, session_id: str,
                       user_message: str, assistant_reply: str) -> None:
    """
    Upsert the conversation turn into DynamoDB.

    Strategy: load existing messages, append the two new turns, write back.
    Uses a conditional expression-free approach (overwrite) — safe because
    only one Lambda instance writes to a given userId+sessionId at a time
    (the UI is sequential: wait for reply before sending next message).
    """
    now = datetime.now(timezone.utc).isoformat()
    ttl = int(time.time()) + CONVERSATION_TTL_DAYS * 86_400

    new_turns = [
        {'role': 'user',      'content': user_message,    'timestamp': now},
        {'role': 'assistant', 'content': assistant_reply,  'timestamp': now},
    ]

    try:
        # Fetch existing item (if any) to append turns
        resp = _conv_table.get_item(
            Key={'userId': user_id, 'sessionId': session_id},
            ProjectionExpression='messages, title, messageCount',
        )
        item = resp.get('Item')

        if item:
            existing = json.loads(item.get('messages', '[]'))
            title    = item.get('title', user_message[:80])
            count    = int(item.get('messageCount', 0))
        else:
            existing = []
            title    = user_message[:80]
            count    = 0

        all_messages = existing + new_turns

        _conv_table.put_item(Item={
            'userId':       user_id,
            'sessionId':    session_id,
            'title':        title,
            'messages':     json.dumps(all_messages),
            'messageCount': count + 2,
            'updatedAt':    now,
            'ttl':          ttl,
        })
        logger.info(f"Saved conversation | user={user_id[:8]}... | session={session_id[:8]}... | turns={count + 2}")

    except Exception as e:
        # Non-fatal — the chat response was already sent; just log
        logger.warning(f"Failed to save conversation to DynamoDB: {e}")


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

    user_id = _get_user_id(event)
    logger.info(f"Chat request | user={user_id[:8]}... | session={session_id} | message_len={len(message)}")

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

    # Persist turn to DynamoDB (non-blocking failure — chat always responds)
    _save_conversation(user_id, session_id, message, reply)

    return _cors_response(200, {'reply': reply, 'sessionId': session_id})
