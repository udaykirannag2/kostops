"""
quicksight_setup_handler.py — CDK Custom Resource handler
----------------------------------------------------------
Multi-dashboard architecture: 7 QuickSight dashboards across
Cost Visibility and Optimization nav sections.

Dashboards built via the QuickSight Definition API (no cid-cmd):
  kostops-cost-intelligence  — Overview (existing, kept for backwards compat)
  kostops-billing-summary    — Invoice/blended spend, charge-type breakdown
  kostops-compute            — EC2/Lambda/ECS/EKS/Fargate cost & usage
  kostops-storage            — S3/EBS/EFS/Glacier combined storage costs
  kostops-ai-ml              — SageMaker/Bedrock/Rekognition/Comprehend/etc.
  kostops-commitments        — RI/SP coverage, charge-type trend
  kostops-rightsizing        — Instance family cost, on-demand waste

Every dashboard includes interactive filter controls:
  - Date Range (relative, N months default)
  - Linked Account (multi-select dropdown)
  - Region (multi-select dropdown)
  - Charge Type (billing-summary and commitments only)
"""

import os
import json
import time
import logging
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

AWS_REGION       = os.environ.get('AWS_REGION_NAME',       'us-east-1')
ACCOUNT_ID       = os.environ.get('AWS_ACCOUNT_ID',        '')
ATHENA_WORKGROUP = os.environ.get('ATHENA_WORKGROUP',      'kostops-workgroup')
RESULTS_BUCKET   = os.environ.get('ATHENA_RESULTS_BUCKET', '')
GLUE_DATABASE    = os.environ.get('GLUE_DATABASE',         'kostops_cur')
CUR_TABLE        = os.environ.get('CUR_TABLE',             'data')

# ── Stable resource IDs ───────────────────────────────────────────────────────
DATASOURCE_ID   = 'kostops-athena-source'
DATASET_SUMMARY = 'kostops-summary-view'
DATASET_ACCOUNT = 'kostops-account-map'
DATASET_COMPUTE = 'kostops-compute-view'
DATASET_STORAGE = 'kostops-storage-view'

DASHBOARD_OVERVIEW = 'kostops-cost-intelligence'   # backwards compat
DASHBOARD_BILLING  = 'kostops-billing-summary'
DASHBOARD_COMPUTE  = 'kostops-compute'
DASHBOARD_STORAGE  = 'kostops-storage'
DASHBOARD_AI_ML    = 'kostops-ai-ml'
DASHBOARD_COMMIT   = 'kostops-commitments'
DASHBOARD_RIGHT    = 'kostops-rightsizing'

QS_NAMESPACE = 'default'

# ── AI/ML product codes for invisible filter ──────────────────────────────────
AI_ML_PRODUCT_CODES = [
    'AmazonSageMaker', 'AmazonBedrock', 'AmazonRekognition',
    'AmazonComprehend', 'AmazonTextract', 'AmazonPolly',
    'AmazonTranslate', 'AmazonLex', 'AmazonForecast',
    'AmazonPersonalize', 'AmazonKendra', 'AWSDeepLearningAMIs',
]

# ── Commitment/RI/SP charge types ─────────────────────────────────────────────
COMMITMENT_CHARGE_TYPES = [
    'SavingsPlanCoveredUsage', 'SavingsPlanRecurringFee',
    'SavingsPlanNegation',     'DiscountedUsage',
    'RIFee',                   'Fee',
    'Usage',  # on-demand — included for comparison
]

# ══════════════════════════════════════════════════════════════════════════════
# Athena SQL views
# ══════════════════════════════════════════════════════════════════════════════

SUMMARY_VIEW_SQL = """\
CREATE OR REPLACE VIEW summary_view AS
SELECT
  CAST(line_item_usage_start_date AS DATE)         AS usage_date,
  DATE_FORMAT(line_item_usage_start_date, '%Y-%m') AS billing_period,
  line_item_usage_account_id                        AS linked_account_id,
  COALESCE(NULLIF(bill_payer_account_id, ''),
           line_item_usage_account_id)              AS payer_account_id,
  product_servicecode                               AS product_name,
  line_item_product_code                            AS product_code,
  line_item_line_item_type                          AS charge_type,
  product_region_code                               AS region,
  ROUND(SUM(line_item_unblended_cost), 4)           AS unblended_cost,
  ROUND(SUM(line_item_blended_cost),   4)           AS blended_cost,
  SUM(line_item_usage_amount)                       AS usage_quantity,
  line_item_currency_code                           AS currency_code
FROM {cur_table}
WHERE line_item_line_item_type NOT IN ('Credit', 'Refund', 'Tax')
GROUP BY 1,2,3,4,5,6,7,8,12
"""

ACCOUNT_MAP_SQL = """\
CREATE OR REPLACE VIEW account_map AS
SELECT DISTINCT
  line_item_usage_account_id AS account_id,
  line_item_usage_account_id AS account_name
FROM {cur_table}
"""

COMPUTE_VIEW_SQL = """\
CREATE OR REPLACE VIEW compute_view AS
SELECT
  CAST(line_item_usage_start_date AS DATE)         AS usage_date,
  DATE_FORMAT(line_item_usage_start_date, '%Y-%m') AS billing_period,
  line_item_usage_account_id                        AS linked_account_id,
  COALESCE(NULLIF(bill_payer_account_id, ''),
           line_item_usage_account_id)              AS payer_account_id,
  product_servicecode                               AS product_name,
  line_item_product_code                            AS product_code,
  product_instance_type                             AS instance_type,
  product_region_code                               AS region,
  line_item_line_item_type                          AS charge_type,
  line_item_operation                               AS operation,
  ROUND(SUM(line_item_unblended_cost), 4)           AS unblended_cost,
  SUM(line_item_usage_amount)                       AS usage_quantity,
  line_item_currency_code                           AS currency_code
FROM {cur_table}
WHERE line_item_product_code IN (
  'AmazonEC2','AmazonECS','AmazonEKS','AWSLambda','AWSFargate'
)
AND line_item_line_item_type NOT IN ('Credit', 'Refund', 'Tax')
GROUP BY 1,2,3,4,5,6,7,8,9,10,13
"""

STORAGE_VIEW_SQL = """\
CREATE OR REPLACE VIEW storage_view AS
SELECT
  CAST(line_item_usage_start_date AS DATE)         AS usage_date,
  DATE_FORMAT(line_item_usage_start_date, '%Y-%m') AS billing_period,
  line_item_usage_account_id                        AS linked_account_id,
  COALESCE(NULLIF(bill_payer_account_id, ''),
           line_item_usage_account_id)              AS payer_account_id,
  product_servicecode                               AS product_name,
  line_item_product_code                            AS product_code,
  CASE
    WHEN line_item_usage_type LIKE '%gp2%'       THEN 'gp2'
    WHEN line_item_usage_type LIKE '%gp3%'       THEN 'gp3'
    WHEN line_item_usage_type LIKE '%io1%'       THEN 'io1'
    WHEN line_item_usage_type LIKE '%io2%'       THEN 'io2'
    WHEN line_item_usage_type LIKE '%st1%'       THEN 'st1'
    WHEN line_item_usage_type LIKE '%sc1%'       THEN 'sc1'
    WHEN line_item_usage_type LIKE '%standard%'  THEN 'standard'
    WHEN line_item_usage_type LIKE '%Glacier%'   THEN 'Glacier'
    WHEN line_item_usage_type LIKE '%INTELLIGENT%' THEN 'Intelligent-Tiering'
    ELSE product_usagetype
  END                                               AS storage_class,
  product_region_code                               AS region,
  line_item_line_item_type                          AS charge_type,
  ROUND(SUM(line_item_unblended_cost), 4)           AS unblended_cost,
  SUM(line_item_usage_amount)                       AS usage_quantity,
  line_item_currency_code                           AS currency_code
FROM {cur_table}
WHERE (
  line_item_product_code IN ('AmazonS3', 'AmazonEFS', 'AmazonFSx', 'AmazonGlacier', 'AmazonS3GlacierDeepArchive')
  OR (
    line_item_product_code = 'AmazonEC2'
    AND line_item_usage_type LIKE '%EBS%'
  )
)
AND line_item_line_item_type NOT IN ('Credit', 'Refund', 'Tax')
GROUP BY 1,2,3,4,5,6,7,8,9,12
"""

# ── QuickSight column type maps ───────────────────────────────────────────────

SUMMARY_COLUMNS = [
    {'Name': 'usage_date',        'Type': 'DATETIME'},
    {'Name': 'billing_period',    'Type': 'STRING'},
    {'Name': 'linked_account_id', 'Type': 'STRING'},
    {'Name': 'payer_account_id',  'Type': 'STRING'},
    {'Name': 'product_name',      'Type': 'STRING'},
    {'Name': 'product_code',      'Type': 'STRING'},
    {'Name': 'charge_type',       'Type': 'STRING'},
    {'Name': 'region',            'Type': 'STRING'},
    {'Name': 'unblended_cost',    'Type': 'DECIMAL'},
    {'Name': 'blended_cost',      'Type': 'DECIMAL'},
    {'Name': 'usage_quantity',    'Type': 'DECIMAL'},
    {'Name': 'currency_code',     'Type': 'STRING'},
]

ACCOUNT_MAP_COLUMNS = [
    {'Name': 'account_id',   'Type': 'STRING'},
    {'Name': 'account_name', 'Type': 'STRING'},
]

COMPUTE_COLUMNS = [
    {'Name': 'usage_date',        'Type': 'DATETIME'},
    {'Name': 'billing_period',    'Type': 'STRING'},
    {'Name': 'linked_account_id', 'Type': 'STRING'},
    {'Name': 'payer_account_id',  'Type': 'STRING'},
    {'Name': 'product_name',      'Type': 'STRING'},
    {'Name': 'product_code',      'Type': 'STRING'},
    {'Name': 'instance_type',     'Type': 'STRING'},
    {'Name': 'region',            'Type': 'STRING'},
    {'Name': 'charge_type',       'Type': 'STRING'},
    {'Name': 'operation',         'Type': 'STRING'},
    {'Name': 'unblended_cost',    'Type': 'DECIMAL'},
    {'Name': 'usage_quantity',    'Type': 'DECIMAL'},
    {'Name': 'currency_code',     'Type': 'STRING'},
]

STORAGE_COLUMNS = [
    {'Name': 'usage_date',        'Type': 'DATETIME'},
    {'Name': 'billing_period',    'Type': 'STRING'},
    {'Name': 'linked_account_id', 'Type': 'STRING'},
    {'Name': 'payer_account_id',  'Type': 'STRING'},
    {'Name': 'product_name',      'Type': 'STRING'},
    {'Name': 'product_code',      'Type': 'STRING'},
    {'Name': 'storage_class',     'Type': 'STRING'},
    {'Name': 'region',            'Type': 'STRING'},
    {'Name': 'charge_type',       'Type': 'STRING'},
    {'Name': 'unblended_cost',    'Type': 'DECIMAL'},
    {'Name': 'usage_quantity',    'Type': 'DECIMAL'},
    {'Name': 'currency_code',     'Type': 'STRING'},
]

# ── Clients ───────────────────────────────────────────────────────────────────

_athena = boto3.client('athena',     region_name=AWS_REGION)
_qs     = boto3.client('quicksight', region_name=AWS_REGION)


# ══════════════════════════════════════════════════════════════════════════════
# Entry point
# ══════════════════════════════════════════════════════════════════════════════

def handler(event, context):
    logger.info(f"QuickSight setup event: {json.dumps(event, default=str)}")
    request_type = event['RequestType']
    props        = event['ResourceProperties']
    if request_type == 'Delete':
        return _handle_delete(props)
    return _handle_create_or_update(props)


# ══════════════════════════════════════════════════════════════════════════════
# Create / Update
# ══════════════════════════════════════════════════════════════════════════════

def _handle_create_or_update(props):
    logger.info('Starting multi-dashboard QuickSight setup...')

    # 1. Athena views ─────────────────────────────────────────────────────────
    logger.info('Step 1/5: Creating Athena views...')
    for sql in [SUMMARY_VIEW_SQL, ACCOUNT_MAP_SQL, COMPUTE_VIEW_SQL, STORAGE_VIEW_SQL]:
        _run_athena_view(sql.format(cur_table=CUR_TABLE))
    logger.info('All 4 Athena views ready.')

    # 2. QS admin user ────────────────────────────────────────────────────────
    logger.info('Step 2/5: Locating QuickSight admin user...')
    admin_arn = _get_qs_admin_arn()
    logger.info(f'Admin ARN: {admin_arn}')

    # 3. Data source ──────────────────────────────────────────────────────────
    logger.info('Step 3/5: Ensuring data source...')
    ds_arn = _ensure_data_source(admin_arn)

    # 4. Datasets ─────────────────────────────────────────────────────────────
    logger.info('Step 4/5: Ensuring datasets...')
    summary_arn = _ensure_dataset(DATASET_SUMMARY, 'summary_view', SUMMARY_COLUMNS, ds_arn, admin_arn)
    account_arn = _ensure_dataset(DATASET_ACCOUNT, 'account_map',  ACCOUNT_MAP_COLUMNS, ds_arn, admin_arn)
    compute_arn = _ensure_dataset(DATASET_COMPUTE, 'compute_view', COMPUTE_COLUMNS, ds_arn, admin_arn)
    storage_arn = _ensure_dataset(DATASET_STORAGE, 'storage_view', STORAGE_COLUMNS, ds_arn, admin_arn)
    logger.info('All 4 datasets ready.')

    # 5. Dashboards ───────────────────────────────────────────────────────────
    logger.info('Step 5/5: Creating/updating 7 dashboards...')
    dashboards = [
        (DASHBOARD_OVERVIEW, 'KostOps Cost Overview',       _build_overview_definition(summary_arn, account_arn)),
        (DASHBOARD_BILLING,  'KostOps Billing Summary',     _build_billing_definition(summary_arn)),
        (DASHBOARD_COMPUTE,  'KostOps Compute',             _build_compute_definition(compute_arn)),
        (DASHBOARD_STORAGE,  'KostOps Storage',             _build_storage_definition(storage_arn)),
        (DASHBOARD_AI_ML,    'KostOps AI & ML',             _build_ai_ml_definition(summary_arn)),
        (DASHBOARD_COMMIT,   'KostOps Commitments',         _build_commitments_definition(summary_arn)),
        (DASHBOARD_RIGHT,    'KostOps Rightsizing & Waste', _build_rightsizing_definition(compute_arn)),
    ]

    arns = {}
    for dash_id, dash_name, definition in dashboards:
        logger.info(f'  → {dash_id}')
        arn = _ensure_dashboard(dash_id, dash_name, definition, admin_arn)
        arns[dash_id] = arn
        logger.info(f'    ARN: {arn}')

    # 6. SPICE refreshes ──────────────────────────────────────────────────────
    for ds_id in [DATASET_SUMMARY, DATASET_ACCOUNT, DATASET_COMPUTE, DATASET_STORAGE]:
        _trigger_spice_refresh(ds_id)

    logger.info('QuickSight multi-dashboard setup complete.')
    return {
        'PhysicalResourceId': 'kostops-quicksight-setup',
        'Data': {
            'DashboardArnOverview':       arns[DASHBOARD_OVERVIEW],
            'DashboardArnBillingSummary': arns[DASHBOARD_BILLING],
            'DashboardArnCompute':        arns[DASHBOARD_COMPUTE],
            'DashboardArnStorage':        arns[DASHBOARD_STORAGE],
            'DashboardArnAiMl':           arns[DASHBOARD_AI_ML],
            'DashboardArnCommitments':    arns[DASHBOARD_COMMIT],
            'DashboardArnRightsizing':    arns[DASHBOARD_RIGHT],
        },
    }


# ══════════════════════════════════════════════════════════════════════════════
# Delete
# ══════════════════════════════════════════════════════════════════════════════

def _handle_delete(props):
    logger.info('Deleting QuickSight resources (best-effort)...')
    for dash_id in [DASHBOARD_OVERVIEW, DASHBOARD_BILLING, DASHBOARD_COMPUTE,
                    DASHBOARD_STORAGE, DASHBOARD_AI_ML, DASHBOARD_COMMIT, DASHBOARD_RIGHT]:
        _safe_delete('dashboard', dash_id)
    for ds_id in [DATASET_SUMMARY, DATASET_ACCOUNT, DATASET_COMPUTE, DATASET_STORAGE]:
        _safe_delete('dataset', ds_id)
    _safe_delete('datasource', DATASOURCE_ID)
    return {'PhysicalResourceId': 'kostops-quicksight-setup'}


# ══════════════════════════════════════════════════════════════════════════════
# Definition API — field helpers
# ══════════════════════════════════════════════════════════════════════════════

def _col(ds, name):
    return {'DataSetIdentifier': ds, 'ColumnName': name}

def _cat(fid, ds, col_name):
    return {'CategoricalDimensionField': {'FieldId': fid, 'Column': _col(ds, col_name)}}

def _date(fid, ds, col_name, granularity='MONTH'):
    return {'DateDimensionField': {
        'FieldId': fid, 'Column': _col(ds, col_name), 'DateGranularity': granularity,
    }}

def _num(fid, ds, col_name, agg='SUM'):
    return {'NumericalMeasureField': {
        'FieldId': fid,
        'Column': _col(ds, col_name),
        'AggregationFunction': {'SimpleNumericalAggregation': agg},
    }}

def _title(text):
    return {'Visibility': 'VISIBLE', 'FormatText': {'PlainText': text}}

def _grid(vid, c, r, w, h):
    return {'ElementId': vid, 'ElementType': 'VISUAL',
            'ColumnIndex': c, 'RowIndex': r, 'ColumnSpan': w, 'RowSpan': h}


# ══════════════════════════════════════════════════════════════════════════════
# Definition API — filter helpers
# ══════════════════════════════════════════════════════════════════════════════

def _std_filters(ds_id, pfx, months_back=3, include_region=True,
                  include_charge_type=False, sheet_id=None):
    """
    Build standard filter groups and controls for a dashboard.

    Returns (filter_groups, filter_controls) — both lists.
    pfx: short prefix string to make IDs unique per dashboard (e.g. 'bs', 'cmp').
    sheet_id: if provided, scope filters to that specific sheet (SelectedSheets).
              Required when the dashboard has more than one sheet; recommended always
              to avoid QuickSight cross-sheet filter validation errors.
    """
    groups   = []
    controls = []

    def _scope():
        if sheet_id:
            return {'SelectedSheets': {'SheetVisualScopingConfigurations': [
                {'SheetId': sheet_id, 'Scope': 'ALL_VISUALS'}
            ]}}
        return {'AllSheets': {}}

    # ── Billing period filter (YYYY-MM string — no default restriction) ───────
    # CategoryFilter with SelectAllOptions shows ALL data by default.
    # Users can multi-select specific months (e.g. "2026-01", "2025-12") to filter.
    # Using billing_period (STRING) rather than usage_date (DATETIME) avoids
    # QuickSight date-filter bugs with SPICE data that ends mid-period.
    groups.append({
        'FilterGroupId': f'{pfx}-fg-date',
        'Filters': [{
            'CategoryFilter': {
                'FilterId': f'{pfx}-f-date',
                'Column':   _col(ds_id, 'billing_period'),
                'Configuration': {
                    'FilterListConfiguration': {
                        'MatchOperator': 'CONTAINS',
                        'SelectAllOptions': 'FILTER_ALL_VALUES',
                        'NullOption':    'ALL_VALUES',
                    }
                },
            }
        }],
        'ScopeConfiguration': _scope(),
        'CrossDataset': 'SINGLE_DATASET',
        'Status': 'ENABLED',
    })
    controls.append({
        'Dropdown': {
            'FilterControlId': f'{pfx}-fc-date',
            'Title':           'Billing Period',
            'SourceFilterId':  f'{pfx}-f-date',
            'Type':            'MULTI_SELECT',
        }
    })

    # ── Linked account filter ─────────────────────────────────────────────────
    groups.append({
        'FilterGroupId': f'{pfx}-fg-acct',
        'Filters': [{
            'CategoryFilter': {
                'FilterId': f'{pfx}-f-acct',
                'Column':   _col(ds_id, 'linked_account_id'),
                'Configuration': {
                    'FilterListConfiguration': {
                        'MatchOperator':    'CONTAINS',
                        'SelectAllOptions': 'FILTER_ALL_VALUES',
                        'NullOption':       'ALL_VALUES',
                    }
                },
            }
        }],
        'ScopeConfiguration': _scope(),
        'CrossDataset': 'SINGLE_DATASET',
        'Status': 'ENABLED',
    })
    controls.append({
        'Dropdown': {
            'FilterControlId': f'{pfx}-fc-acct',
            'Title':           'Linked Account',
            'SourceFilterId':  f'{pfx}-f-acct',
            'Type':            'MULTI_SELECT',
        }
    })

    # ── Region filter ─────────────────────────────────────────────────────────
    if include_region:
        groups.append({
            'FilterGroupId': f'{pfx}-fg-region',
            'Filters': [{
                'CategoryFilter': {
                    'FilterId': f'{pfx}-f-region',
                    'Column':   _col(ds_id, 'region'),
                    'Configuration': {
                        'FilterListConfiguration': {
                            'MatchOperator':    'CONTAINS',
                            'SelectAllOptions': 'FILTER_ALL_VALUES',
                            'NullOption':       'ALL_VALUES',
                        }
                    },
                }
            }],
            'ScopeConfiguration': _scope(),
            'CrossDataset': 'SINGLE_DATASET',
            'Status': 'ENABLED',
        })
        controls.append({
            'Dropdown': {
                'FilterControlId': f'{pfx}-fc-region',
                'Title':           'Region',
                'SourceFilterId':  f'{pfx}-f-region',
                'Type':            'MULTI_SELECT',
            }
        })

    # ── Charge type filter ────────────────────────────────────────────────────
    if include_charge_type:
        groups.append({
            'FilterGroupId': f'{pfx}-fg-ct',
            'Filters': [{
                'CategoryFilter': {
                    'FilterId': f'{pfx}-f-ct',
                    'Column':   _col(ds_id, 'charge_type'),
                    'Configuration': {
                        'FilterListConfiguration': {
                            'MatchOperator':    'CONTAINS',
                            'SelectAllOptions': 'FILTER_ALL_VALUES',
                            'NullOption':       'ALL_VALUES',
                        }
                    },
                }
            }],
            'ScopeConfiguration': _scope(),
            'CrossDataset': 'SINGLE_DATASET',
            'Status': 'ENABLED',
        })
        controls.append({
            'Dropdown': {
                'FilterControlId': f'{pfx}-fc-ct',
                'Title':           'Charge Type',
                'SourceFilterId':  f'{pfx}-f-ct',
                'Type':            'MULTI_SELECT',
            }
        })

    return groups, controls


def _invisible_category_filter(pfx, ds_id, col_name, values, fg_suffix='hidden'):
    """
    Returns a filter group that restricts a column to specific values
    WITHOUT a visible filter control (used for AI/ML and Commitments dashboards).
    """
    return {
        'FilterGroupId': f'{pfx}-fg-{fg_suffix}',
        'Filters': [{
            'CategoryFilter': {
                'FilterId': f'{pfx}-f-{fg_suffix}',
                'Column':   _col(ds_id, col_name),
                'Configuration': {
                    'FilterListConfiguration': {
                        'MatchOperator': 'CONTAINS',
                        'NullOption':    'NON_NULLS_ONLY',
                        'CategoryValues': values,
                    }
                },
            }
        }],
        'ScopeConfiguration': {'AllSheets': {}},
        'CrossDataset': 'SINGLE_DATASET',
        'Status': 'ENABLED',
    }


# ══════════════════════════════════════════════════════════════════════════════
# Dashboard builders
# ══════════════════════════════════════════════════════════════════════════════

def _build_overview_definition(summary_arn: str, account_arn: str) -> dict:
    """Original Cost Overview dashboard — kept for backwards compatibility."""
    DS = 'summary_view'

    def col(ds, name):  return _col(ds, name)
    def cat(fid, ds, c): return _cat(fid, ds, c)
    def date(fid, ds, c, g='MONTH'): return _date(fid, ds, c, g)
    def num(fid, ds, c, a='SUM'):    return _num(fid, ds, c, a)

    return {
        'DataSetIdentifierDeclarations': [
            {'Identifier': 'summary_view', 'DataSetArn': summary_arn},
            {'Identifier': 'account_map',  'DataSetArn': account_arn},
        ],
        'Sheets': [{
            'SheetId': 'cost-overview',
            'Name': 'Cost Overview',
            'Visuals': [
                {'LineChartVisual': {
                    'VisualId': 'monthly-trend',
                    'Title': _title('Monthly Unblended Cost ($)'),
                    'ChartConfiguration': {
                        'FieldWells': {'LineChartAggregatedFieldWells': {
                            'Category': [cat('f-date', DS, 'billing_period')],
                            'Values':   [num('f-cost', DS, 'unblended_cost')],
                        }},
                        'Type': 'LINE',
                    },
                }},
                {'BarChartVisual': {
                    'VisualId': 'top-services',
                    'Title': _title('Top Services by Cost'),
                    'ChartConfiguration': {
                        'FieldWells': {'BarChartAggregatedFieldWells': {
                            'Category': [cat('f-svc', DS, 'product_name')],
                            'Values':   [num('f-svc-c', DS, 'unblended_cost')],
                        }},
                        'Orientation': 'HORIZONTAL',
                        'BarsArrangement': 'CLUSTERED',
                        'SortConfiguration': {
                            'CategorySort': [{'FieldSort': {'FieldId': 'f-svc-c', 'Direction': 'DESC'}}],
                            'CategoryItemsLimit': {'ItemsLimit': 10, 'OtherCategories': 'EXCLUDE'},
                        },
                    },
                }},
                {'TableVisual': {
                    'VisualId': 'cost-by-account',
                    'Title': _title('Cost by Linked Account'),
                    'ChartConfiguration': {
                        'FieldWells': {'TableAggregatedFieldWells': {
                            'GroupBy': [cat('f-acct', DS, 'linked_account_id')],
                            'Values':  [num('f-acct-c', DS, 'unblended_cost')],
                        }},
                    },
                }},
                {'BarChartVisual': {
                    'VisualId': 'cost-by-region',
                    'Title': _title('Cost by AWS Region'),
                    'ChartConfiguration': {
                        'FieldWells': {'BarChartAggregatedFieldWells': {
                            'Category': [cat('f-rgn', DS, 'region')],
                            'Values':   [num('f-rgn-c', DS, 'unblended_cost')],
                        }},
                        'Orientation': 'HORIZONTAL',
                        'BarsArrangement': 'CLUSTERED',
                        'SortConfiguration': {
                            'CategorySort': [{'FieldSort': {'FieldId': 'f-rgn-c', 'Direction': 'DESC'}}],
                            'CategoryItemsLimit': {'ItemsLimit': 10, 'OtherCategories': 'EXCLUDE'},
                        },
                    },
                }},
            ],
            'Layouts': [{'Configuration': {'GridLayout': {'Elements': [
                _grid('monthly-trend',   0, 0,  36, 12),
                _grid('top-services',    0, 12, 18, 12),
                _grid('cost-by-account', 18, 12, 18, 12),
                _grid('cost-by-region',  0, 24, 36, 12),
            ]}}}],
        }],
    }


def _build_billing_definition(summary_arn: str) -> dict:
    """
    Billing Summary dashboard.
    Visuals:
      1. Invoice spend by account — stacked vertical bar, monthly
      2. Blended spend by account — stacked vertical bar, monthly
      3. Charge type breakdown   — donut
      4. Invoice service spend   — horizontal stacked bar (service × account)
    Filters: Date Range (13M), Linked Account, Region, Charge Type
    """
    DS   = 'bs-ds'
    PFX  = 'bs'
    SHEET = 'billing-sheet'

    filter_groups, filter_controls = _std_filters(
        DS, PFX, months_back=13, include_region=True, include_charge_type=True,
        sheet_id=SHEET,
    )

    visuals = [
        # 1. Invoice spend by account (stacked bar — monthly)
        {'BarChartVisual': {
            'VisualId': 'bs-v1',
            'Title': _title('Invoice Spend by Account (Monthly)'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('bs-v1-dt', DS, 'billing_period')],
                    'Values':   [_num('bs-v1-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('bs-v1-acct', DS, 'linked_account_id')],
                }},
                'Orientation': 'VERTICAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'bs-v1-dt', 'Direction': 'ASC'}}],
                    'ColorItemsLimit': {'ItemsLimit': 10, 'OtherCategories': 'INCLUDE'},
                },
            },
        }},
        # 2. Blended (amortized proxy) spend by account
        {'BarChartVisual': {
            'VisualId': 'bs-v2',
            'Title': _title('Blended Cost by Account (Monthly)'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('bs-v2-dt', DS, 'billing_period')],
                    'Values':   [_num('bs-v2-cost', DS, 'blended_cost')],
                    'Colors':   [_cat('bs-v2-acct', DS, 'linked_account_id')],
                }},
                'Orientation': 'VERTICAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'bs-v2-dt', 'Direction': 'ASC'}}],
                    'ColorItemsLimit': {'ItemsLimit': 10, 'OtherCategories': 'INCLUDE'},
                },
            },
        }},
        # 3. Charge type donut
        {'PieChartVisual': {
            'VisualId': 'bs-v3',
            'Title': _title('Charge Type Breakdown'),
            'ChartConfiguration': {
                'FieldWells': {'PieChartAggregatedFieldWells': {
                    'Category': [_cat('bs-v3-ct', DS, 'charge_type')],
                    'Values':   [_num('bs-v3-cost', DS, 'unblended_cost')],
                }},
                'DonutOptions': {'ArcOptions': {'ArcThickness': 'MEDIUM'}},
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'bs-v3-cost', 'Direction': 'DESC'}}],
                    'CategoryItemsLimit': {'ItemsLimit': 10, 'OtherCategories': 'INCLUDE'},
                },
            },
        }},
        # 4. Service spend by account (horizontal stacked bar)
        {'BarChartVisual': {
            'VisualId': 'bs-v4',
            'Title': _title('Invoice Service Spend by Account'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('bs-v4-svc', DS, 'product_name')],
                    'Values':   [_num('bs-v4-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('bs-v4-acct', DS, 'linked_account_id')],
                }},
                'Orientation': 'HORIZONTAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'bs-v4-cost', 'Direction': 'DESC'}}],
                    'CategoryItemsLimit': {'ItemsLimit': 15, 'OtherCategories': 'INCLUDE'},
                    'ColorItemsLimit':    {'ItemsLimit': 10, 'OtherCategories': 'INCLUDE'},
                },
            },
        }},
    ]

    return {
        'DataSetIdentifierDeclarations': [{'Identifier': DS, 'DataSetArn': summary_arn}],
        'FilterGroups': filter_groups,
        'Sheets': [{
            'SheetId': SHEET, 'Name': 'Billing Summary',
            'FilterControls': filter_controls,
            'Visuals': visuals,
            'Layouts': [{'Configuration': {'GridLayout': {'Elements': [
                _grid('bs-v1', 0, 0,  36, 12),
                _grid('bs-v2', 0, 12, 18, 12),
                _grid('bs-v3', 18, 12, 18, 12),
                _grid('bs-v4', 0, 24, 36, 12),
            ]}}}],
        }],
    }


def _build_compute_definition(compute_arn: str) -> dict:
    """
    Compute dashboard — EC2, Lambda, ECS, EKS, Fargate.
    Filters: Date Range (3M), Linked Account, Region
    """
    DS   = 'cmp-ds'
    PFX  = 'cmp'
    SHEET = 'compute-sheet'

    filter_groups, filter_controls = _std_filters(DS, PFX, months_back=3, include_region=True, sheet_id=SHEET)

    visuals = [
        # 1. Monthly compute cost by service (stacked bar)
        {'BarChartVisual': {
            'VisualId': 'cmp-v1',
            'Title': _title('Monthly Compute Cost by Service'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('cmp-v1-dt', DS, 'billing_period')],
                    'Values':   [_num('cmp-v1-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('cmp-v1-svc', DS, 'product_name')],
                }},
                'Orientation': 'VERTICAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'cmp-v1-dt', 'Direction': 'ASC'}}],
                },
            },
        }},
        # 2. Top instance types (horizontal bar, EC2 only)
        {'BarChartVisual': {
            'VisualId': 'cmp-v2',
            'Title': _title('Top Instance Types by Cost'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('cmp-v2-inst', DS, 'instance_type')],
                    'Values':   [_num('cmp-v2-cost', DS, 'unblended_cost')],
                }},
                'Orientation': 'HORIZONTAL',
                'BarsArrangement': 'CLUSTERED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'cmp-v2-cost', 'Direction': 'DESC'}}],
                    'CategoryItemsLimit': {'ItemsLimit': 20, 'OtherCategories': 'EXCLUDE'},
                },
            },
        }},
        # 3. Compute cost by account (table)
        {'TableVisual': {
            'VisualId': 'cmp-v3',
            'Title': _title('Compute Cost by Account'),
            'ChartConfiguration': {
                'FieldWells': {'TableAggregatedFieldWells': {
                    'GroupBy': [
                        _cat('cmp-v3-acct', DS, 'linked_account_id'),
                        _cat('cmp-v3-svc', DS, 'product_name'),
                    ],
                    'Values':  [_num('cmp-v3-cost', DS, 'unblended_cost')],
                }},
                'SortConfiguration': {
                    'RowSort': [{'FieldSort': {'FieldId': 'cmp-v3-cost', 'Direction': 'DESC'}}],
                },
            },
        }},
        # 4. On-demand vs Reserved (donut)
        {'PieChartVisual': {
            'VisualId': 'cmp-v4',
            'Title': _title('Charge Type Breakdown'),
            'ChartConfiguration': {
                'FieldWells': {'PieChartAggregatedFieldWells': {
                    'Category': [_cat('cmp-v4-ct', DS, 'charge_type')],
                    'Values':   [_num('cmp-v4-cost', DS, 'unblended_cost')],
                }},
                'DonutOptions': {'ArcOptions': {'ArcThickness': 'MEDIUM'}},
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'cmp-v4-cost', 'Direction': 'DESC'}}],
                },
            },
        }},
    ]

    return {
        'DataSetIdentifierDeclarations': [{'Identifier': DS, 'DataSetArn': compute_arn}],
        'FilterGroups': filter_groups,
        'Sheets': [{
            'SheetId': SHEET, 'Name': 'Compute',
            'FilterControls': filter_controls,
            'Visuals': visuals,
            'Layouts': [{'Configuration': {'GridLayout': {'Elements': [
                _grid('cmp-v1', 0, 0,  36, 12),
                _grid('cmp-v2', 0, 12, 18, 12),
                _grid('cmp-v4', 18, 12, 18, 12),
                _grid('cmp-v3', 0, 24, 36, 12),
            ]}}}],
        }],
    }


def _build_storage_definition(storage_arn: str) -> dict:
    """
    Storage dashboard — S3, EBS, EFS, FSx, Glacier combined.
    Filters: Date Range (3M), Linked Account, Region
    """
    DS   = 'sto-ds'
    PFX  = 'sto'
    SHEET = 'storage-sheet'

    filter_groups, filter_controls = _std_filters(DS, PFX, months_back=3, include_region=True, sheet_id=SHEET)

    visuals = [
        # 1. Monthly storage cost by service (stacked bar)
        {'BarChartVisual': {
            'VisualId': 'sto-v1',
            'Title': _title('Monthly Storage Cost by Service'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('sto-v1-dt', DS, 'billing_period')],
                    'Values':   [_num('sto-v1-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('sto-v1-svc', DS, 'product_name')],
                }},
                'Orientation': 'VERTICAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'sto-v1-dt', 'Direction': 'ASC'}}],
                },
            },
        }},
        # 2. Storage class breakdown (horizontal bar)
        {'BarChartVisual': {
            'VisualId': 'sto-v2',
            'Title': _title('Cost by Storage Class / Volume Type'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('sto-v2-cls', DS, 'storage_class')],
                    'Values':   [_num('sto-v2-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('sto-v2-svc', DS, 'product_name')],
                }},
                'Orientation': 'HORIZONTAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'sto-v2-cost', 'Direction': 'DESC'}}],
                    'CategoryItemsLimit': {'ItemsLimit': 15, 'OtherCategories': 'INCLUDE'},
                },
            },
        }},
        # 3. Storage cost by account (table)
        {'TableVisual': {
            'VisualId': 'sto-v3',
            'Title': _title('Storage Cost by Account'),
            'ChartConfiguration': {
                'FieldWells': {'TableAggregatedFieldWells': {
                    'GroupBy': [
                        _cat('sto-v3-acct', DS, 'linked_account_id'),
                        _cat('sto-v3-svc', DS, 'product_name'),
                    ],
                    'Values': [_num('sto-v3-cost', DS, 'unblended_cost')],
                }},
                'SortConfiguration': {
                    'RowSort': [{'FieldSort': {'FieldId': 'sto-v3-cost', 'Direction': 'DESC'}}],
                },
            },
        }},
        # 4. S3 vs EBS vs EFS cost trend (line chart)
        {'LineChartVisual': {
            'VisualId': 'sto-v4',
            'Title': _title('Storage Cost Trend by Service'),
            'ChartConfiguration': {
                'FieldWells': {'LineChartAggregatedFieldWells': {
                    'Category': [_cat('sto-v4-dt', DS, 'billing_period')],
                    'Values':   [_num('sto-v4-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('sto-v4-svc', DS, 'product_name')],
                }},
                'Type': 'LINE',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'sto-v4-dt', 'Direction': 'ASC'}}],
                },
            },
        }},
    ]

    return {
        'DataSetIdentifierDeclarations': [{'Identifier': DS, 'DataSetArn': storage_arn}],
        'FilterGroups': filter_groups,
        'Sheets': [{
            'SheetId': SHEET, 'Name': 'Storage',
            'FilterControls': filter_controls,
            'Visuals': visuals,
            'Layouts': [{'Configuration': {'GridLayout': {'Elements': [
                _grid('sto-v1', 0, 0,  36, 12),
                _grid('sto-v2', 0, 12, 18, 12),
                _grid('sto-v4', 18, 12, 18, 12),
                _grid('sto-v3', 0, 24, 36, 12),
            ]}}}],
        }],
    }


def _build_ai_ml_definition(summary_arn: str) -> dict:
    """
    AI & ML dashboard — SageMaker, Bedrock, Rekognition, Comprehend, etc.
    Uses summary_view with an invisible filter restricting to AI/ML product codes.
    Filters: Date Range (3M), Linked Account
    """
    DS   = 'aiml-ds'
    PFX  = 'aiml'
    SHEET = 'aiml-sheet'

    filter_groups, filter_controls = _std_filters(
        DS, PFX, months_back=3, include_region=False, sheet_id=SHEET,
    )

    # Invisible filter: restrict to AI/ML product codes
    aiml_hidden = _invisible_category_filter(PFX, DS, 'product_code', AI_ML_PRODUCT_CODES, 'aiml-svc')
    aiml_hidden['ScopeConfiguration'] = {'SelectedSheets': {'SheetVisualScopingConfigurations': [
        {'SheetId': SHEET, 'Scope': 'ALL_VISUALS'}
    ]}}
    filter_groups.append(aiml_hidden)

    visuals = [
        # 1. Monthly AI/ML cost trend by service (stacked bar)
        {'BarChartVisual': {
            'VisualId': 'aiml-v1',
            'Title': _title('Monthly AI & ML Cost by Service'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('aiml-v1-dt', DS, 'billing_period')],
                    'Values':   [_num('aiml-v1-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('aiml-v1-svc', DS, 'product_name')],
                }},
                'Orientation': 'VERTICAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'aiml-v1-dt', 'Direction': 'ASC'}}],
                },
            },
        }},
        # 2. AI/ML service cost (horizontal bar, sorted by cost)
        {'BarChartVisual': {
            'VisualId': 'aiml-v2',
            'Title': _title('AI & ML Cost by Service'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('aiml-v2-svc', DS, 'product_name')],
                    'Values':   [_num('aiml-v2-cost', DS, 'unblended_cost')],
                }},
                'Orientation': 'HORIZONTAL',
                'BarsArrangement': 'CLUSTERED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'aiml-v2-cost', 'Direction': 'DESC'}}],
                    'CategoryItemsLimit': {'ItemsLimit': 15, 'OtherCategories': 'EXCLUDE'},
                },
            },
        }},
        # 3. AI/ML cost by account (table)
        {'TableVisual': {
            'VisualId': 'aiml-v3',
            'Title': _title('AI & ML Cost by Account'),
            'ChartConfiguration': {
                'FieldWells': {'TableAggregatedFieldWells': {
                    'GroupBy': [
                        _cat('aiml-v3-acct', DS, 'linked_account_id'),
                        _cat('aiml-v3-svc', DS, 'product_name'),
                    ],
                    'Values': [_num('aiml-v3-cost', DS, 'unblended_cost')],
                }},
                'SortConfiguration': {
                    'RowSort': [{'FieldSort': {'FieldId': 'aiml-v3-cost', 'Direction': 'DESC'}}],
                },
            },
        }},
    ]

    return {
        'DataSetIdentifierDeclarations': [{'Identifier': DS, 'DataSetArn': summary_arn}],
        'FilterGroups': filter_groups,
        'Sheets': [{
            'SheetId': SHEET, 'Name': 'AI & ML',
            'FilterControls': filter_controls,
            'Visuals': visuals,
            'Layouts': [{'Configuration': {'GridLayout': {'Elements': [
                _grid('aiml-v1', 0, 0,  36, 12),
                _grid('aiml-v2', 0, 12, 18, 12),
                _grid('aiml-v3', 18, 12, 18, 12),
            ]}}}],
        }],
    }


def _build_commitments_definition(summary_arn: str) -> dict:
    """
    Coverage & Commitments dashboard — RI/SP utilization and on-demand exposure.
    Shows charge type trends and breakdown to highlight savings plan effectiveness.
    Filters: Date Range (6M), Linked Account, Region, Charge Type
    """
    DS   = 'com-ds'
    PFX  = 'com'
    SHEET = 'commit-sheet'

    filter_groups, filter_controls = _std_filters(
        DS, PFX, months_back=6, include_region=True, include_charge_type=True, sheet_id=SHEET,
    )

    visuals = [
        # 1. Charge type cost trend (stacked bar — shows SP vs RI vs On-Demand over time)
        {'BarChartVisual': {
            'VisualId': 'com-v1',
            'Title': _title('Cost by Charge Type (Monthly)'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('com-v1-dt', DS, 'billing_period')],
                    'Values':   [_num('com-v1-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('com-v1-ct', DS, 'charge_type')],
                }},
                'Orientation': 'VERTICAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'com-v1-dt', 'Direction': 'ASC'}}],
                },
            },
        }},
        # 2. Charge type breakdown donut
        {'PieChartVisual': {
            'VisualId': 'com-v2',
            'Title': _title('Charge Type Breakdown'),
            'ChartConfiguration': {
                'FieldWells': {'PieChartAggregatedFieldWells': {
                    'Category': [_cat('com-v2-ct', DS, 'charge_type')],
                    'Values':   [_num('com-v2-cost', DS, 'unblended_cost')],
                }},
                'DonutOptions': {'ArcOptions': {'ArcThickness': 'MEDIUM'}},
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'com-v2-cost', 'Direction': 'DESC'}}],
                },
            },
        }},
        # 3. Charge type by service (horizontal bar — shows which services use SP/RI)
        {'BarChartVisual': {
            'VisualId': 'com-v3',
            'Title': _title('Charge Type by Service'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('com-v3-svc', DS, 'product_name')],
                    'Values':   [_num('com-v3-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('com-v3-ct', DS, 'charge_type')],
                }},
                'Orientation': 'HORIZONTAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'com-v3-cost', 'Direction': 'DESC'}}],
                    'CategoryItemsLimit': {'ItemsLimit': 15, 'OtherCategories': 'INCLUDE'},
                },
            },
        }},
        # 4. Cost by account and charge type (table)
        {'TableVisual': {
            'VisualId': 'com-v4',
            'Title': _title('Cost by Account and Charge Type'),
            'ChartConfiguration': {
                'FieldWells': {'TableAggregatedFieldWells': {
                    'GroupBy': [
                        _cat('com-v4-acct', DS, 'linked_account_id'),
                        _cat('com-v4-ct', DS, 'charge_type'),
                    ],
                    'Values': [_num('com-v4-cost', DS, 'unblended_cost')],
                }},
                'SortConfiguration': {
                    'RowSort': [{'FieldSort': {'FieldId': 'com-v4-cost', 'Direction': 'DESC'}}],
                },
            },
        }},
    ]

    return {
        'DataSetIdentifierDeclarations': [{'Identifier': DS, 'DataSetArn': summary_arn}],
        'FilterGroups': filter_groups,
        'Sheets': [{
            'SheetId': SHEET, 'Name': 'Coverage & Commitments',
            'FilterControls': filter_controls,
            'Visuals': visuals,
            'Layouts': [{'Configuration': {'GridLayout': {'Elements': [
                _grid('com-v1', 0, 0,  36, 12),
                _grid('com-v2', 0, 12, 18, 12),
                _grid('com-v3', 18, 12, 18, 12),
                _grid('com-v4', 0, 24, 36, 12),
            ]}}}],
        }],
    }


def _build_rightsizing_definition(compute_arn: str) -> dict:
    """
    Rightsizing & Waste dashboard — instance family costs, on-demand waste.
    Uses compute_view dataset (EC2/ECS/Lambda/EKS/Fargate).
    Filters: Date Range (3M), Linked Account, Region
    """
    DS   = 'rgt-ds'
    PFX  = 'rgt'
    SHEET = 'rightsizing-sheet'

    filter_groups, filter_controls = _std_filters(DS, PFX, months_back=3, include_region=True, sheet_id=SHEET)

    visuals = [
        # 1. EC2 cost by instance family (horizontal bar — grouped by first two chars of instance_type)
        {'BarChartVisual': {
            'VisualId': 'rgt-v1',
            'Title': _title('Compute Cost by Instance Type'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('rgt-v1-inst', DS, 'instance_type')],
                    'Values':   [_num('rgt-v1-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('rgt-v1-svc', DS, 'product_name')],
                }},
                'Orientation': 'HORIZONTAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'rgt-v1-cost', 'Direction': 'DESC'}}],
                    'CategoryItemsLimit': {'ItemsLimit': 25, 'OtherCategories': 'INCLUDE'},
                },
            },
        }},
        # 2. On-demand vs reserved by service (stacked bar)
        {'BarChartVisual': {
            'VisualId': 'rgt-v2',
            'Title': _title('On-Demand vs Committed Cost by Service'),
            'ChartConfiguration': {
                'FieldWells': {'BarChartAggregatedFieldWells': {
                    'Category': [_cat('rgt-v2-svc', DS, 'product_name')],
                    'Values':   [_num('rgt-v2-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('rgt-v2-ct', DS, 'charge_type')],
                }},
                'Orientation': 'HORIZONTAL',
                'BarsArrangement': 'STACKED',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'rgt-v2-cost', 'Direction': 'DESC'}}],
                },
            },
        }},
        # 3. Compute monthly trend (line chart)
        {'LineChartVisual': {
            'VisualId': 'rgt-v3',
            'Title': _title('Compute Cost Trend by Service'),
            'ChartConfiguration': {
                'FieldWells': {'LineChartAggregatedFieldWells': {
                    'Category': [_cat('rgt-v3-dt', DS, 'billing_period')],
                    'Values':   [_num('rgt-v3-cost', DS, 'unblended_cost')],
                    'Colors':   [_cat('rgt-v3-svc', DS, 'product_name')],
                }},
                'Type': 'LINE',
                'SortConfiguration': {
                    'CategorySort': [{'FieldSort': {'FieldId': 'rgt-v3-dt', 'Direction': 'ASC'}}],
                },
            },
        }},
        # 4. Compute cost by account (table)
        {'TableVisual': {
            'VisualId': 'rgt-v4',
            'Title': _title('Compute Cost by Account'),
            'ChartConfiguration': {
                'FieldWells': {'TableAggregatedFieldWells': {
                    'GroupBy': [
                        _cat('rgt-v4-acct', DS, 'linked_account_id'),
                        _cat('rgt-v4-svc', DS, 'product_name'),
                    ],
                    'Values': [_num('rgt-v4-cost', DS, 'unblended_cost')],
                }},
                'SortConfiguration': {
                    'RowSort': [{'FieldSort': {'FieldId': 'rgt-v4-cost', 'Direction': 'DESC'}}],
                },
            },
        }},
    ]

    return {
        'DataSetIdentifierDeclarations': [{'Identifier': DS, 'DataSetArn': compute_arn}],
        'FilterGroups': filter_groups,
        'Sheets': [{
            'SheetId': SHEET, 'Name': 'Rightsizing & Waste',
            'FilterControls': filter_controls,
            'Visuals': visuals,
            'Layouts': [{'Configuration': {'GridLayout': {'Elements': [
                _grid('rgt-v1', 0, 0,  18, 12),
                _grid('rgt-v2', 18, 0, 18, 12),
                _grid('rgt-v3', 0, 12, 36, 12),
                _grid('rgt-v4', 0, 24, 36, 12),
            ]}}}],
        }],
    }


# ══════════════════════════════════════════════════════════════════════════════
# Athena helpers
# ══════════════════════════════════════════════════════════════════════════════

def _run_athena_view(sql: str) -> None:
    resp = _athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={'Database': GLUE_DATABASE},
        WorkGroup=ATHENA_WORKGROUP,
    )
    execution_id = resp['QueryExecutionId']
    for _ in range(60):
        status = _athena.get_query_execution(QueryExecutionId=execution_id)
        state  = status['QueryExecution']['Status']['State']
        if state == 'SUCCEEDED':
            return
        if state in ('FAILED', 'CANCELLED'):
            reason = status['QueryExecution']['Status'].get('StateChangeReason', '')
            raise RuntimeError(f'Athena DDL {state}: {reason}')
        time.sleep(2)
    raise TimeoutError('Athena view creation timed out')


# ══════════════════════════════════════════════════════════════════════════════
# QuickSight helpers
# ══════════════════════════════════════════════════════════════════════════════

def _get_qs_admin_arn() -> str:
    PRIVILEGED_ROLES = {'ADMIN', 'ADMIN_PRO', 'AUTHOR', 'AUTHOR_PRO'}
    paginator = _qs.get_paginator('list_users')
    for page in paginator.paginate(AwsAccountId=ACCOUNT_ID, Namespace=QS_NAMESPACE):
        for user in page.get('UserList', []):
            if user.get('Role') in PRIVILEGED_ROLES:
                return user['Arn']
    raise RuntimeError('No QuickSight admin user found — subscribe to QS Enterprise first.')


def _ensure_data_source(admin_arn: str) -> str:
    try:
        resp = _qs.describe_data_source(AwsAccountId=ACCOUNT_ID, DataSourceId=DATASOURCE_ID)
        return resp['DataSource']['Arn']
    except ClientError as e:
        if e.response['Error']['Code'] != 'ResourceNotFoundException':
            raise
    resp = _qs.create_data_source(
        AwsAccountId=ACCOUNT_ID,
        DataSourceId=DATASOURCE_ID,
        Name='KostOps Athena (kostops-workgroup)',
        Type='ATHENA',
        DataSourceParameters={'AthenaParameters': {'WorkGroup': ATHENA_WORKGROUP}},
        Permissions=[{
            'Principal': admin_arn,
            'Actions': [
                'quicksight:DescribeDataSource', 'quicksight:DescribeDataSourcePermissions',
                'quicksight:PassDataSource',     'quicksight:UpdateDataSource',
                'quicksight:DeleteDataSource',   'quicksight:UpdateDataSourcePermissions',
            ],
        }],
        SslProperties={'DisableSsl': False},
    )
    _wait_for_data_source(DATASOURCE_ID)
    return resp['Arn']


def _wait_for_data_source(ds_id: str, timeout: int = 120) -> None:
    for _ in range(timeout // 5):
        resp   = _qs.describe_data_source(AwsAccountId=ACCOUNT_ID, DataSourceId=ds_id)
        status = resp['DataSource']['Status']
        if status == 'CREATION_SUCCESSFUL':
            return
        if 'FAILED' in status or 'ERROR' in status:
            raise RuntimeError(f'Data source creation failed: {status}')
        time.sleep(5)
    raise TimeoutError(f'Timed out waiting for data source {ds_id}')


def _ensure_dataset(dataset_id, view_name, columns, ds_arn, admin_arn) -> str:
    dataset_arn = f'arn:aws:quicksight:{AWS_REGION}:{ACCOUNT_ID}:dataset/{dataset_id}'
    physical_table = {'RelationalTable': {
        'DataSourceArn': ds_arn,
        'Catalog':       'AwsDataCatalog',
        'Schema':        GLUE_DATABASE,
        'Name':          view_name,
        'InputColumns':  columns,
    }}
    logical_table = {'Alias': view_name, 'Source': {'PhysicalTableId': 'primary'}}
    permissions = [{
        'Principal': admin_arn,
        'Actions': [
            'quicksight:DescribeDataSet',          'quicksight:DescribeDataSetPermissions',
            'quicksight:PassDataSet',              'quicksight:DescribeIngestion',
            'quicksight:ListIngestions',           'quicksight:UpdateDataSet',
            'quicksight:DeleteDataSet',            'quicksight:CreateIngestion',
            'quicksight:CancelIngestion',          'quicksight:UpdateDataSetPermissions',
        ],
    }]
    try:
        _qs.describe_data_set(AwsAccountId=ACCOUNT_ID, DataSetId=dataset_id)
        _qs.update_data_set(
            AwsAccountId=ACCOUNT_ID, DataSetId=dataset_id,
            Name=f'KostOps {view_name}',
            PhysicalTableMap={'primary': physical_table},
            LogicalTableMap={'primary': logical_table},
            ImportMode='SPICE',
        )
    except ClientError as e:
        if e.response['Error']['Code'] != 'ResourceNotFoundException':
            raise
        _qs.create_data_set(
            AwsAccountId=ACCOUNT_ID, DataSetId=dataset_id,
            Name=f'KostOps {view_name}',
            PhysicalTableMap={'primary': physical_table},
            LogicalTableMap={'primary': logical_table},
            ImportMode='SPICE',
            Permissions=permissions,
        )
    return dataset_arn


def _ensure_dashboard(dashboard_id: str, dashboard_name: str, definition: dict, admin_arn: str) -> str:
    dashboard_arn = f'arn:aws:quicksight:{AWS_REGION}:{ACCOUNT_ID}:dashboard/{dashboard_id}'
    permissions = [{
        'Principal': admin_arn,
        'Actions': [
            'quicksight:DescribeDashboard',          'quicksight:ListDashboardVersions',
            'quicksight:UpdateDashboardPermissions',  'quicksight:QueryDashboard',
            'quicksight:UpdateDashboard',             'quicksight:DeleteDashboard',
            'quicksight:UpdateDashboardPublishedVersion', 'quicksight:DescribeDashboardPermissions',
        ],
    }]
    try:
        _qs.describe_dashboard(AwsAccountId=ACCOUNT_ID, DashboardId=dashboard_id)
        resp = _qs.update_dashboard(
            AwsAccountId=ACCOUNT_ID, DashboardId=dashboard_id,
            Name=dashboard_name, Definition=definition,
        )
        version_num = int(resp['VersionArn'].split('/')[-1])
        _wait_for_dashboard_version(dashboard_id, version_num)
        for attempt in range(6):
            try:
                _qs.update_dashboard_published_version(
                    AwsAccountId=ACCOUNT_ID, DashboardId=dashboard_id, VersionNumber=version_num,
                )
                break
            except ClientError as publish_err:
                if publish_err.response['Error']['Code'] == 'ConflictException' and attempt < 5:
                    time.sleep(5)
                else:
                    raise
    except ClientError as e:
        code = e.response['Error']['Code']
        if code == 'UnsupportedUserEditionException':
            raise RuntimeError('QuickSight Enterprise Edition required.') from e
        if code != 'ResourceNotFoundException':
            raise
        resp = _qs.create_dashboard(
            AwsAccountId=ACCOUNT_ID, DashboardId=dashboard_id,
            Name=dashboard_name, Definition=definition,
            Permissions=permissions,
            DashboardPublishOptions={
                'AdHocFilteringOption': {'AvailabilityStatus': 'ENABLED'},
                'ExportToCSVOption':    {'AvailabilityStatus': 'ENABLED'},
                'SheetControlsOption':  {'VisibilityState': 'EXPANDED'},
            },
        )
        dashboard_arn = resp['Arn']
        _wait_for_dashboard(dashboard_id)
    return dashboard_arn


def _wait_for_dashboard_version(dashboard_id: str, version_num: int, timeout: int = 120) -> None:
    """Wait for a specific dashboard version to finish creating/updating."""
    for _ in range(timeout // 5):
        resp   = _qs.describe_dashboard(
            AwsAccountId=ACCOUNT_ID, DashboardId=dashboard_id, VersionNumber=version_num,
        )
        status = resp['Dashboard']['Version']['Status']
        if status in ('CREATION_SUCCESSFUL', 'UPDATE_SUCCESSFUL'):
            return
        if 'FAILED' in status or 'ERROR' in status:
            errors = resp['Dashboard']['Version'].get('Errors', [])
            raise RuntimeError(f'Dashboard {dashboard_id} v{version_num} failed: {status} — {errors}')
        time.sleep(5)
    raise TimeoutError(f'Timed out waiting for dashboard {dashboard_id} v{version_num}')


def _wait_for_dashboard(dashboard_id: str, timeout: int = 120) -> None:
    for _ in range(timeout // 5):
        resp   = _qs.describe_dashboard(AwsAccountId=ACCOUNT_ID, DashboardId=dashboard_id)
        status = resp['Dashboard']['Version']['Status']
        if status in ('CREATION_SUCCESSFUL', 'UPDATE_SUCCESSFUL'):
            return
        if 'FAILED' in status or 'ERROR' in status:
            errors = resp['Dashboard']['Version'].get('Errors', [])
            raise RuntimeError(f'Dashboard {dashboard_id} failed: {status} — {errors}')
        time.sleep(5)
    raise TimeoutError(f'Timed out waiting for dashboard {dashboard_id}')


def _trigger_spice_refresh(dataset_id: str) -> None:
    try:
        _qs.create_ingestion(
            AwsAccountId=ACCOUNT_ID, DataSetId=dataset_id,
            IngestionId=f'setup-{int(time.time())}',
            IngestionType='FULL_REFRESH',
        )
        logger.info(f'SPICE refresh triggered: {dataset_id}')
    except Exception as e:
        logger.warning(f'SPICE refresh non-fatal error for {dataset_id}: {e}')


def _safe_delete(resource_type: str, resource_id: str) -> None:
    try:
        if resource_type == 'dashboard':
            _qs.delete_dashboard(AwsAccountId=ACCOUNT_ID, DashboardId=resource_id)
        elif resource_type == 'dataset':
            _qs.delete_data_set(AwsAccountId=ACCOUNT_ID, DataSetId=resource_id)
        elif resource_type == 'datasource':
            _qs.delete_data_source(AwsAccountId=ACCOUNT_ID, DataSourceId=resource_id)
        logger.info(f'Deleted {resource_type}: {resource_id}')
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceNotFoundException':
            logger.info(f'{resource_type} {resource_id} already gone')
        else:
            logger.warning(f'Non-fatal delete error for {resource_type} {resource_id}: {e}')
