"""
Findings Handler
----------------
Lambda function that exposes CRUD operations on the DynamoDB findings table
to the React UI via API Gateway.

Routes (all require Cognito JWT):
  GET    /findings            → list findings (default: OPEN, sorted by savings)
  GET    /findings/{id}       → get a single finding
  PATCH  /findings/{id}       → update finding status (OPEN → RESOLVED | IGNORED)
                                 ↳ admin group only; writes an AuditEvents row
"""

import os
import json
import logging
from datetime import datetime, timezone
import boto3
from boto3.dynamodb.conditions import Key

from common.roles import require_admin, PermissionDenied, forbidden_response
from common.audit import write_audit

logger         = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

FINDINGS_TABLE = os.environ['FINDINGS_TABLE']
AWS_REGION     = os.environ.get('AWS_REGION', 'us-east-1')

_ddb   = boto3.resource('dynamodb', region_name=AWS_REGION)
_table = _ddb.Table(FINDINGS_TABLE)

VALID_STATUSES = {'OPEN', 'RESOLVED', 'IGNORED'}


def _cors_response(status_code: int, body) -> dict:
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body, default=str),
    }


def _list_findings(query_params: dict) -> dict:
    status = (query_params or {}).get('status', 'OPEN').upper()
    if status not in VALID_STATUSES:
        status = 'OPEN'

    limit = min(int((query_params or {}).get('limit', 50)), 200)

    response = _table.query(
        IndexName='status-index',
        KeyConditionExpression=Key('status').eq(status),
        ScanIndexForward=False,
        Limit=limit,
    )
    findings = response.get('Items', [])
    findings.sort(
        key=lambda f: float(f.get('estimatedMonthlySavings', 0)),
        reverse=True,
    )
    return _cors_response(200, {'findings': findings, 'count': len(findings)})


def _get_finding(finding_id: str, query_params: dict) -> dict:
    # createdAt is required as query param because it's the DynamoDB sort key
    created_at = (query_params or {}).get('createdAt')
    if not created_at:
        return _cors_response(400, {'error': 'createdAt query parameter is required'})

    response = _table.get_item(
        Key={'findingId': finding_id, 'createdAt': created_at}
    )
    item = response.get('Item')
    if not item:
        return _cors_response(404, {'error': 'Finding not found'})
    return _cors_response(200, item)


def _update_finding(event: dict, finding_id: str, body: dict) -> dict:
    new_status = (body or {}).get('status', '').upper()
    created_at = (body or {}).get('createdAt', '')

    if new_status not in VALID_STATUSES:
        return _cors_response(400, {'error': f'status must be one of {VALID_STATUSES}'})
    if not created_at:
        return _cors_response(400, {'error': 'createdAt is required in request body'})

    # Capture prior status for the audit row
    prior = _table.get_item(
        Key={'findingId': finding_id, 'createdAt': created_at}
    ).get('Item') or {}
    prior_status = prior.get('status')

    updated_at = datetime.now(timezone.utc).isoformat()
    response = _table.update_item(
        Key={'findingId': finding_id, 'createdAt': created_at},
        UpdateExpression='SET #s = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={':status': new_status, ':updatedAt': updated_at},
        ConditionExpression='attribute_exists(findingId)',
        ReturnValues='ALL_NEW',
    )

    write_audit(
        event,
        action='STATUS_CHANGE',
        entity_type='Finding',
        entity_id=finding_id,
        before={'status': prior_status} if prior_status else None,
        after={'status': new_status},
        source='UI',
    )
    return _cors_response(200, response.get('Attributes', {}))


def handler(event: dict, context) -> dict:
    method      = event.get('httpMethod', '')
    path_params = event.get('pathParameters') or {}
    query_params = event.get('queryStringParameters') or {}
    finding_id  = path_params.get('id')

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _cors_response(400, {'error': 'Invalid JSON body'})

    logger.info(f"Findings request | method={method} | id={finding_id}")

    if method == 'GET' and not finding_id:
        return _list_findings(query_params)

    if method == 'GET' and finding_id:
        return _get_finding(finding_id, query_params)

    if method == 'PATCH' and finding_id:
        try:
            require_admin(event)
        except PermissionDenied:
            return forbidden_response()
        return _update_finding(event, finding_id, body)

    return _cors_response(405, {'error': f'Method {method} not allowed'})
