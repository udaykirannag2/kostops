"""
Chat Sessions Handler
---------------------
Serves conversation history from DynamoDB so the React UI can
reload a session after a page refresh or on a different device.

Routes:
  GET /chat/sessions
    Returns the 20 most recent session summaries for the caller.
    Response: { sessions: [{ sessionId, title, updatedAt, messageCount }] }

  GET /chat/sessions/{sessionId}
    Returns the full message history for a specific session.
    Response: { sessionId, title, messages: [{role, content, timestamp}],
                updatedAt, messageCount }

The userId is extracted from the Cognito JWT claims that API Gateway
injects into requestContext.authorizer.claims.sub — no extra auth needed.
"""

import os
import json
import logging

import boto3
from boto3.dynamodb.conditions import Key

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

CONVERSATIONS_TABLE = os.environ.get('CONVERSATIONS_TABLE', 'kostops-conversations')
AWS_REGION          = os.environ.get('AWS_REGION', 'us-east-1')

_ddb        = boto3.resource('dynamodb', region_name=AWS_REGION)
_conv_table = _ddb.Table(CONVERSATIONS_TABLE)


def _cors(status: int, body: dict) -> dict:
    return {
        'statusCode': status,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body),
    }


def _get_user_id(event: dict) -> str:
    return (
        event.get('requestContext', {})
             .get('authorizer', {})
             .get('claims', {})
             .get('sub', 'anonymous')
    )


def handler(event: dict, context) -> dict:
    method      = event.get('httpMethod', 'GET')
    path_params = event.get('pathParameters') or {}
    session_id  = path_params.get('sessionId')
    user_id     = _get_user_id(event)

    if method != 'GET':
        return _cors(405, {'error': 'Method not allowed'})

    if session_id:
        return _get_session(user_id, session_id)
    else:
        return _list_sessions(user_id)


def _list_sessions(user_id: str) -> dict:
    """Return the 20 most recent session summaries (no messages payload)."""
    try:
        resp = _conv_table.query(
            KeyConditionExpression=Key('userId').eq(user_id),
            # Fetch only summary fields — messages can be large
            ProjectionExpression='sessionId, title, updatedAt, messageCount',
        )
        sessions = sorted(
            resp.get('Items', []),
            key=lambda s: s.get('updatedAt', ''),
            reverse=True,
        )[:20]

        # Ensure messageCount is an int (DynamoDB returns Decimal)
        for s in sessions:
            s['messageCount'] = int(s.get('messageCount', 0))

        logger.info(f"Listed {len(sessions)} sessions for user {user_id[:8]}...")
        return _cors(200, {'sessions': sessions})

    except Exception as e:
        logger.error(f"list_sessions error: {e}")
        return _cors(500, {'error': str(e)})


def _get_session(user_id: str, session_id: str) -> dict:
    """Return full message history for a specific session."""
    try:
        resp = _conv_table.get_item(
            Key={'userId': user_id, 'sessionId': session_id},
        )
        item = resp.get('Item')

        if not item:
            return _cors(404, {'error': 'Session not found'})

        # messages is stored as a JSON string to avoid DynamoDB's
        # 400 KB item limit being eaten by individual attribute overhead
        messages = json.loads(item.get('messages', '[]'))

        logger.info(f"Fetched session {session_id[:8]}... for user {user_id[:8]}...")
        return _cors(200, {
            'sessionId':    session_id,
            'title':        item.get('title', ''),
            'messages':     messages,
            'updatedAt':    item.get('updatedAt', ''),
            'messageCount': int(item.get('messageCount', 0)),
        })

    except Exception as e:
        logger.error(f"get_session error: {e}")
        return _cors(500, {'error': str(e)})
