"""
CUR Prefix Detector — CDK cr.Provider Lambda
---------------------------------------------
Auto-detects the S3 prefix where CUR Athena-compatible parquet files live,
by scanning the payer CUR bucket for the distinctive Hive partition pattern:

  BILLING_PERIOD=YYYY-MM/

AWS CUR with Athena integration ALWAYS creates this structure:
  s3://<bucket>/<anything>/data/BILLING_PERIOD=YYYY-MM/<uuid>.parquet

No other AWS-generated files in a CUR bucket use BILLING_PERIOD= partitions,
so this pattern uniquely identifies the correct data/ prefix.

Returns CloudFormation attribute: CurDataPrefix
  e.g. "costreports/CUR/data/"

Called from: stacks/data-stack.ts via cdk.CustomResource + cr.Provider
Runs in:     linked account (which already has cross-account s3:ListBucket
             access to the payer CUR bucket via payer stack bucket policy)
"""

import os
import json
import logging
import boto3

logger     = logging.getLogger()
logger.setLevel(logging.INFO)
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')
_s3        = boto3.client('s3', region_name=AWS_REGION)


def detect_cur_prefix(bucket: str) -> str:
    """
    Scan up to 1,000 keys in the bucket for the first key containing
    'BILLING_PERIOD=' and return the prefix up to that point.

    Example:
      Key:    costreports/CUR/data/BILLING_PERIOD=2026-01/abc.parquet
      Returns: costreports/CUR/data/
    """
    paginator = _s3.get_paginator('list_objects_v2')
    pages = paginator.paginate(Bucket=bucket, PaginationConfig={'MaxItems': 1000})

    for page in pages:
        for obj in page.get('Contents', []):
            key = obj['Key']
            if 'BILLING_PERIOD=' in key:
                prefix = key[:key.find('BILLING_PERIOD=')]
                logger.info(f"Detected CUR prefix: s3://{bucket}/{prefix}")
                return prefix

    raise ValueError(
        f"No BILLING_PERIOD= partitions found in s3://{bucket}. "
        f"Ensure CUR is configured with Parquet format and "
        f"'Athena-compatible S3 prefixes' enabled."
    )


def handler(event: dict, context) -> dict:
    """
    CDK cr.Provider calling convention:
      - Receive event with RequestType + ResourceProperties
      - Return dict with PhysicalResourceId and Data attributes
      - Provider framework handles the CloudFormation response
    """
    logger.info(f"RequestType={event.get('RequestType')} Props={event.get('ResourceProperties')}")
    request_type = event.get('RequestType', '')
    bucket       = event['ResourceProperties']['CurBucketName']
    physical_id  = f"cur-prefix-{bucket}"

    # On Delete — nothing to undo, just acknowledge
    if request_type == 'Delete':
        return {'PhysicalResourceId': physical_id}

    prefix = detect_cur_prefix(bucket)
    return {
        'PhysicalResourceId': physical_id,
        'Data': {'CurDataPrefix': prefix},
    }
