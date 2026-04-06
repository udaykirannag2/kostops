"""
Slack Command Handler
---------------------
Receives Slack slash commands (/kostops) and responds with agent answers.

Slack requires a response within 3 seconds — this handler immediately ACKs
the request, then fires an async Lambda self-invocation to call the agent
and post the result back via Slack's response_url.

Flow:
  1. Slack sends POST /slack/command
  2. This handler validates the signature, ACKs with 200 + "thinking..." message
  3. Async Lambda invocation processes the question via AgentCore
  4. Answer posted to response_url (Slack shows it in the channel)

Slash command setup (in your Slack App):
  Command:      /kostops
  Request URL:  https://<your-api-gateway-url>/slack/command
  Description:  Ask your AWS FinOps agent anything about cost

Environment variables:
  SLACK_SIGNING_SECRET    — from Slack App → Basic Information
  AGENT_RUNTIME_ARN       — AgentCore Runtime ARN
  AWS_REGION              — us-east-1
"""

import os
import json
import hmac
import hashlib
import logging
import time
import urllib.request
import urllib.parse

import boto3

logger                = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

SLACK_SIGNING_SECRET  = os.environ.get('SLACK_SIGNING_SECRET', '')
AGENT_RUNTIME_ARN     = os.environ.get('AGENT_RUNTIME_ARN', '')
AWS_REGION            = os.environ.get('AWS_REGION', 'us-east-1')

_lambda = boto3.client('lambda', region_name=AWS_REGION)
_agent  = boto3.client('bedrock-agentcore', region_name=AWS_REGION)


# ── Signature verification ────────────────────────────────────────────────────

def _verify_slack_signature(event: dict) -> bool:
    """Verify the request is genuinely from Slack using HMAC-SHA256."""
    if not SLACK_SIGNING_SECRET:
        logger.warning('SLACK_SIGNING_SECRET not set — skipping verification')
        return True  # Allow during initial setup; tighten after config

    headers      = {k.lower(): v for k, v in (event.get('headers') or {}).items()}
    timestamp    = headers.get('x-slack-request-timestamp', '')
    slack_sig    = headers.get('x-slack-signature', '')
    raw_body     = event.get('body', '') or ''

    # Reject requests older than 5 minutes (replay attack prevention)
    try:
        if abs(time.time() - int(timestamp)) > 300:
            logger.warning('Slack request timestamp too old')
            return False
    except (ValueError, TypeError):
        return False

    sig_basestring = f'v0:{timestamp}:{raw_body}'
    computed = 'v0=' + hmac.new(
        SLACK_SIGNING_SECRET.encode(),
        sig_basestring.encode(),
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(computed, slack_sig)


# ── Response helpers ──────────────────────────────────────────────────────────

def _ack(message: str) -> dict:
    """Immediate ACK response to Slack (must arrive < 3s)."""
    return {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps({
            'response_type': 'in_channel',
            'text': message,
        }),
    }


def _post_to_slack(response_url: str, text: str, is_error: bool = False) -> None:
    """Post the final agent answer back to Slack via response_url."""
    payload = json.dumps({
        'response_type': 'in_channel',
        'replace_original': True,
        'blocks': [
            {
                'type': 'section',
                'text': {'type': 'mrkdwn', 'text': text},
            },
            {
                'type': 'context',
                'elements': [{'type': 'mrkdwn', 'text': '🤖 KostOps · AWS FinOps Agent'}],
            },
        ] if not is_error else None,
        'text': text,
    }).encode('utf-8')

    req = urllib.request.Request(
        response_url,
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception as e:
        logger.error(f'Failed to post to Slack response_url: {e}')


# ── Async agent invocation ────────────────────────────────────────────────────

def _invoke_agent(question: str, response_url: str, user_name: str) -> None:
    """Call the AgentCore Runtime and post the result back to Slack."""
    import uuid
    session_id = str(uuid.uuid4())

    try:
        response = _agent.invoke_agent_runtime(
            agentRuntimeArn=AGENT_RUNTIME_ARN,
            runtimeSessionId=session_id,
            payload=json.dumps({'inputText': question}).encode('utf-8'),
        )
        body    = response['body'].read() if hasattr(response.get('body', ''), 'read') else response.get('body', b'{}')
        decoded = json.loads(body) if isinstance(body, (bytes, str)) else body
        answer  = decoded.get('output') or decoded.get('text') or 'No response from agent.'
    except Exception as e:
        logger.error(f'Agent invocation failed: {e}')
        answer  = f'❌ Agent error: {e}'

    # Format the answer nicely for Slack
    formatted = f'*Question:* {question}\n\n{answer}'
    _post_to_slack(response_url, formatted)


# ── Main handler ──────────────────────────────────────────────────────────────

def handler(event: dict, context) -> dict:
    """
    Two modes:
      1. Called directly by API Gateway → Slack slash command (ACK immediately)
      2. Called async by self-invocation → process agent + post to response_url
    """
    # Async mode: payload contains response_url + question, not a Slack request
    if event.get('_async'):
        question     = event['question']
        response_url = event['response_url']
        user_name    = event.get('user_name', 'User')
        logger.info(f'Async agent call | user={user_name} | question_len={len(question)}')
        _invoke_agent(question, response_url, user_name)
        return {'statusCode': 200}

    # Slack slash command mode
    if not _verify_slack_signature(event):
        return {'statusCode': 401, 'body': 'Invalid signature'}

    # Parse URL-encoded Slack body
    raw_body = event.get('body', '') or ''
    params   = dict(urllib.parse.parse_qsl(raw_body))

    command      = params.get('command', '/kostops')
    question     = params.get('text', '').strip()
    response_url = params.get('response_url', '')
    user_name    = params.get('user_name', 'User')
    channel_name = params.get('channel_name', 'general')

    logger.info(f'Slack command | user={user_name} | channel={channel_name} | q={question[:80]}')

    if not question:
        return _ack(
            'Hi! Ask me anything about your AWS costs.\n'
            'Example: `/kostops what are my top 3 cost drivers this month?`'
        )

    if not AGENT_RUNTIME_ARN:
        return _ack('❌ Agent not configured. Contact your KostOps admin.')

    # Invoke self asynchronously so we can ACK Slack within 3s
    try:
        _lambda.invoke(
            FunctionName=context.function_name,
            InvocationType='Event',       # async, fire-and-forget
            Payload=json.dumps({
                '_async':       True,
                'question':     question,
                'response_url': response_url,
                'user_name':    user_name,
            }).encode(),
        )
    except Exception as e:
        logger.error(f'Failed to invoke async self: {e}')
        return _ack(f'❌ Failed to start agent: {e}')

    # ACK Slack immediately — agent result will arrive via response_url
    return _ack(f'🔍 Looking into that for you, <@{user_name}>…')
