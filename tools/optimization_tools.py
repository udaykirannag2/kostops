"""
Optimization Tools
------------------
Tools for the KostOps Optimization Agent.

Covers the APIs not already in billing_tools.py:
  - RI utilization + coverage  (Cost Explorer)
  - SP utilization + coverage  (Cost Explorer)
  - Per-service COH recommendations (Cost Optimization Hub)
  - Data transfer costs (Athena/CUR)
  - Opportunity scoring (pure Python, no API call)

All CE/COH tools use payer credentials via payer_role.get_payer_session().
"""

import os
import json
import logging
from typing import Optional
from datetime import date, timedelta

logger     = logging.getLogger(__name__)
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')

# ── Payer credential helpers ──────────────────────────────────────────────────

def _ce():
    """Cost Explorer client with payer credentials (CE is always us-east-1)."""
    from payer_role import get_payer_session
    return get_payer_session().client('ce', region_name='us-east-1')


def _coh():
    """Cost Optimization Hub client with payer credentials."""
    from payer_role import get_payer_session
    return get_payer_session().client('cost-optimization-hub', region_name=AWS_REGION)


# ── Reserved Instance tools ───────────────────────────────────────────────────

def get_reservation_utilization(
    start_date: str,
    end_date: str,
    granularity: str = 'MONTHLY',
    group_by_dimension: str = 'SERVICE',
) -> dict:
    """
    Get Reserved Instance utilization — what fraction of purchased RI hours are used.
    Low utilization means over-committed RIs you are paying for but not using.
    Returns utilization rate %, unused RI hours, and wasted RI cost by service.

    Args:
        start_date:         Start date YYYY-MM-DD (inclusive).
        end_date:           End date YYYY-MM-DD (exclusive).
        granularity:        MONTHLY or DAILY.
        group_by_dimension: SERVICE (default), INSTANCE_TYPE, or REGION.

    Returns:
        Dict with UtilizationsByTime: list of periods with Total and Groups.
    """
    logger.info(f"get_reservation_utilization {start_date} → {end_date}")
    resp = _ce().get_reservation_utilization(
        TimePeriod={'Start': start_date, 'End': end_date},
        Granularity=granularity,
        GroupBy=[{'Type': 'DIMENSION', 'Key': group_by_dimension}],
    )
    # Summarise into a clean structure
    result = []
    for period in resp.get('UtilizationsByTime', []):
        groups = []
        for g in period.get('Groups', []):
            util = g.get('Utilization', {})
            groups.append({
                'key':                     g['Attributes'].get(group_by_dimension, ''),
                'utilizationPercentage':   util.get('UtilizationPercentage', '0'),
                'unusedHours':             util.get('UnusedHours', '0'),
                'purchasedHours':          util.get('PurchasedHours', '0'),
                'onDemandCostOfRIHoursUsed': util.get('OnDemandCostOfRIHoursUsed', {}).get('Amount', '0'),
                'unusedRecurringFee':      util.get('UnusedRecurringFee', {}).get('Amount', '0'),
            })
        result.append({
            'period': f"{period['TimePeriod']['Start']} → {period['TimePeriod']['End']}",
            'total':  period.get('Total', {}),
            'groups': groups,
        })
    return {'utilization': result}


def get_reservation_coverage(
    start_date: str,
    end_date: str,
    granularity: str = 'MONTHLY',
    group_by_dimension: str = 'SERVICE',
) -> dict:
    """
    Get Reserved Instance coverage — what fraction of on-demand hours are covered by RIs.
    Low coverage means opportunity to purchase more RIs to reduce on-demand spend.
    Returns coverage %, on-demand hours not covered, and potential RI savings.

    Args:
        start_date:         Start date YYYY-MM-DD (inclusive).
        end_date:           End date YYYY-MM-DD (exclusive).
        granularity:        MONTHLY or DAILY.
        group_by_dimension: SERVICE (default), INSTANCE_TYPE, or REGION.

    Returns:
        Dict with CoveragesByTime: list of periods with coverage metrics per service.
    """
    logger.info(f"get_reservation_coverage {start_date} → {end_date}")
    resp = _ce().get_reservation_coverage(
        TimePeriod={'Start': start_date, 'End': end_date},
        Granularity=granularity,
        GroupBy=[{'Type': 'DIMENSION', 'Key': group_by_dimension}],
    )
    result = []
    for period in resp.get('CoveragesByTime', []):
        groups = []
        for g in period.get('Groups', []):
            cov = g.get('Coverage', {})
            hours = cov.get('CoverageHours', {})
            groups.append({
                'key':                    g['Attributes'].get(group_by_dimension, ''),
                'coverageHoursPercentage': hours.get('CoverageHoursPercentage', '0'),
                'onDemandHours':          hours.get('OnDemandHours', '0'),
                'reservedHours':          hours.get('ReservedHours', '0'),
                'onDemandCost':           cov.get('CoverageCost', {}).get('OnDemandCost', '0'),
            })
        result.append({
            'period': f"{period['TimePeriod']['Start']} → {period['TimePeriod']['End']}",
            'total':  period.get('Total', {}),
            'groups': groups,
        })
    return {'coverage': result}


def get_reservation_purchase_recommendations(
    service: str = 'Amazon EC2',
    term_in_years: str = 'ONE_YEAR',
    payment_option: str = 'NO_UPFRONT',
    lookback_period: str = 'SIXTY_DAYS',
) -> list:
    """
    Get Reserved Instance purchase recommendations for a service.
    Call this to find RI buy opportunities with estimated savings and ROI.

    Args:
        service:         AWS service name. Valid values:
                         "Amazon EC2", "Amazon RDS", "Amazon ElastiCache",
                         "Amazon OpenSearch Service", "Amazon Redshift".
        term_in_years:   ONE_YEAR or THREE_YEARS.
        payment_option:  NO_UPFRONT, PARTIAL_UPFRONT, or ALL_UPFRONT.
        lookback_period: SEVEN_DAYS, THIRTY_DAYS, or SIXTY_DAYS.

    Returns:
        List of recommendation dicts with instance type, region, estimated savings,
        upfront cost, and break-even months.
    """
    logger.info(f"get_reservation_purchase_recommendations service={service} term={term_in_years}")
    try:
        resp = _ce().get_reservation_purchase_recommendation(
            Service=service,
            TermInYears=term_in_years,
            PaymentOption=payment_option,
            LookbackPeriodInDays=lookback_period,
        )
    except Exception as e:
        logger.warning(f"RI recommendations for {service}: {e}")
        return []

    recs = []
    for rec_group in resp.get('Recommendations', []):
        for detail in rec_group.get('RecommendationDetails', []):
            instance_details = detail.get('InstanceDetails', {})
            # Flatten instance details from whichever service type
            instance_info = {}
            for svc_key in ('EC2InstanceDetails', 'RDSInstanceDetails',
                            'ElastiCacheInstanceDetails', 'RedshiftInstanceDetails',
                            'ESInstanceDetails'):
                if svc_key in instance_details:
                    instance_info = instance_details[svc_key]
                    break

            recs.append({
                'instanceType':              instance_info.get('InstanceType', instance_info.get('NodeType', '')),
                'region':                    instance_info.get('Region', ''),
                'platform':                  instance_info.get('Platform', instance_info.get('ProductDescription', '')),
                'recommendedNumberOfInstances': detail.get('RecommendedNumberOfInstancesToPurchase', '0'),
                'estimatedMonthlySavings':   detail.get('EstimatedMonthlySavingsAmount', '0'),
                'estimatedSavingsPercentage': detail.get('EstimatedSavingsPercentage', '0'),
                'upfrontCost':               detail.get('UpfrontCost', '0'),
                'recurringMonthlyCost':      detail.get('RecurringStandardMonthlyCost', '0'),
                'breakEvenMonths':           detail.get('EstimatedBreakEvenInMonths', ''),
            })
    return recs


# ── Savings Plans tools ───────────────────────────────────────────────────────

def get_savings_plans_utilization(
    start_date: str,
    end_date: str,
    granularity: str = 'MONTHLY',
) -> dict:
    """
    Get Savings Plans utilization — what fraction of purchased SP commitment is used.
    Unused SP commitment is wasted money (you pay for it regardless).
    Low utilization means over-committed SPs — consider downsizing at renewal.

    Args:
        start_date:   Start date YYYY-MM-DD (inclusive).
        end_date:     End date YYYY-MM-DD (exclusive).
        granularity:  MONTHLY or DAILY.

    Returns:
        Dict with utilization %, unused commitment $, net savings achieved.
    """
    logger.info(f"get_savings_plans_utilization {start_date} → {end_date}")
    resp = _ce().get_savings_plans_utilization(
        TimePeriod={'Start': start_date, 'End': end_date},
        Granularity=granularity,
    )
    result = []
    for period in resp.get('SavingsPlansUtilizationsByTime', []):
        util = period.get('Utilization', {})
        savings = period.get('Savings', {})
        result.append({
            'period':                    f"{period['TimePeriod']['Start']} → {period['TimePeriod']['End']}",
            'utilizationPercentage':     util.get('UtilizationPercentage', '0'),
            'totalCommitment':           util.get('TotalCommitment', {}).get('Amount', '0'),
            'usedCommitment':            util.get('UsedCommitment', {}).get('Amount', '0'),
            'unusedCommitment':          util.get('UnusedCommitment', {}).get('Amount', '0'),
            'netSavings':                savings.get('NetSavings', {}).get('Amount', '0'),
            'onDemandCostEquivalent':    savings.get('OnDemandCostEquivalent', {}).get('Amount', '0'),
        })
    total = resp.get('Total', {})
    return {'utilization': result, 'total': total}


def get_savings_plans_coverage(
    start_date: str,
    end_date: str,
    granularity: str = 'MONTHLY',
) -> dict:
    """
    Get Savings Plans coverage — what fraction of eligible spend is covered by SPs.
    Low coverage means uncovered on-demand spend that could be covered by buying more SPs.
    Always check utilization first to avoid over-committing.

    Args:
        start_date:   Start date YYYY-MM-DD (inclusive).
        end_date:     End date YYYY-MM-DD (exclusive).
        granularity:  MONTHLY or DAILY.

    Returns:
        Dict with coverage %, covered spend, on-demand spend not covered.
    """
    logger.info(f"get_savings_plans_coverage {start_date} → {end_date}")
    resp = _ce().get_savings_plans_coverage(
        TimePeriod={'Start': start_date, 'End': end_date},
        Granularity=granularity,
    )
    result = []
    for period in resp.get('SavingsPlansCoverages', []):
        cov = period.get('Coverage', {})
        result.append({
            'period':                f"{period['TimePeriod']['Start']} → {period['TimePeriod']['End']}",
            'coveragePercentage':    cov.get('CoveragePercentage', '0'),
            'spendCoveredBySP':      cov.get('SpendCoveredBySavingsPlans', {}).get('Amount', '0'),
            'onDemandCost':          cov.get('OnDemandCost', {}).get('Amount', '0'),
            'totalCost':             cov.get('TotalCost', {}).get('Amount', '0'),
        })
    total = resp.get('Total', {})
    return {'coverage': result, 'total': total}


# ── Cost Optimization Hub per-service tools ───────────────────────────────────

def get_coh_recommendations_by_service(
    service: str,
    max_results: int = 20,
) -> list:
    """
    Get Cost Optimization Hub recommendations filtered to a specific service type.
    Use this to drill into service-specific optimization opportunities beyond
    what get_cost_optimization_hub_recommendations (grouped summary) returns.

    Args:
        service:     AWS service filter. Valid values:
                     'EC2', 'RDS', 'Lambda', 'ECS', 'EKS',
                     'ElastiCache', 'OpenSearch', 'EBS', 'S3'.
        max_results: Maximum number of recommendations (default 20, max 100).

    Returns:
        List of recommendation dicts with resourceId, current config,
        recommended config, estimated monthly savings, and action type.
    """
    logger.info(f"get_coh_recommendations_by_service service={service}")
    try:
        resp = _coh().list_recommendations(
            filter={
                'resourceTypes': [service],
            },
            maxResults=min(max_results, 100),
        )
    except Exception as e:
        logger.warning(f"COH recommendations for {service}: {e}")
        return []

    recs = []
    for item in resp.get('items', []):
        recs.append({
            'recommendationId':       item.get('recommendationId', ''),
            'accountId':              item.get('accountId', ''),
            'region':                 item.get('region', ''),
            'resourceId':             item.get('resourceId', ''),
            'resourceType':           item.get('resourceType', ''),
            'actionType':             item.get('actionType', ''),
            'estimatedMonthlySavings': item.get('estimatedMonthlySavings', 0),
            'estimatedSavingsPercentage': item.get('estimatedSavingsPercentage', 0),
            'currentResourceType':    item.get('currentResourceType', ''),
            'recommendedResourceType': item.get('recommendedResourceType', ''),
            'implementationEffort':   item.get('implementationEffort', ''),
            'restartNeeded':          item.get('restartNeeded', False),
            'rollbackPossible':       item.get('rollbackPossible', False),
        })
    return recs


def get_coh_recommendation_detail(recommendation_id: str) -> dict:
    """
    Get full detail for a single Cost Optimization Hub recommendation.
    Use this to get implementation steps for a specific resource.

    Args:
        recommendation_id: The recommendation ID from get_coh_recommendations_by_service.

    Returns:
        Dict with full recommendation detail including current/recommended
        resource configuration and estimated cost impact.
    """
    logger.info(f"get_coh_recommendation_detail id={recommendation_id}")
    try:
        resp = _coh().get_recommendation(recommendationId=recommendation_id)
        return resp.get('recommendation', {})
    except Exception as e:
        logger.warning(f"COH recommendation detail {recommendation_id}: {e}")
        return {'error': str(e)}


# ── Data transfer cost tool (Athena) ──────────────────────────────────────────

def get_data_transfer_costs(
    start_date: str,
    end_date: str,
    limit: int = 20,
) -> list:
    """
    Query CUR for data transfer costs broken down by usage type and account.
    Identifies expensive inter-AZ, internet egress, and NAT Gateway charges.
    Use this to find architecture-level optimization opportunities.

    Args:
        start_date: Start date YYYY-MM-DD.
        end_date:   End date YYYY-MM-DD (exclusive).
        limit:      Maximum rows to return (default 20).

    Returns:
        List of dicts with usage_type, account_id, region, total_cost_usd.
        Sorted by cost descending.
    """
    import boto3
    import time as _time

    athena_workgroup     = os.environ.get('ATHENA_WORKGROUP', 'kostops-workgroup')
    glue_database        = os.environ.get('GLUE_DATABASE', 'kostops_cur')
    cur_table            = os.environ.get('CUR_TABLE', 'data')

    sql = f"""
SELECT
    line_item_usage_type,
    line_item_usage_account_id AS account_id,
    product_region             AS region,
    ROUND(SUM(line_item_unblended_cost), 2) AS total_cost_usd
FROM {glue_database}.{cur_table}
WHERE line_item_usage_start_date >= TIMESTAMP '{start_date} 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '{end_date} 00:00:00'
  AND (
        line_item_usage_type LIKE '%DataTransfer%'
     OR line_item_usage_type LIKE '%NatGateway%'
     OR line_item_product_code = 'AWSDataTransfer'
  )
  AND line_item_line_item_type = 'Usage'
GROUP BY
    line_item_usage_type,
    line_item_usage_account_id,
    product_region
HAVING SUM(line_item_unblended_cost) > 1.0
ORDER BY total_cost_usd DESC
LIMIT {limit}
"""

    logger.info(f"get_data_transfer_costs {start_date} → {end_date}")
    athena = boto3.client('athena', region_name=AWS_REGION)

    resp = athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={'Database': glue_database},
        WorkGroup=athena_workgroup,
    )
    execution_id = resp['QueryExecutionId']

    for _ in range(60):
        status = athena.get_query_execution(QueryExecutionId=execution_id)
        state  = status['QueryExecution']['Status']['State']
        if state == 'SUCCEEDED':
            break
        if state in ('FAILED', 'CANCELLED'):
            reason = status['QueryExecution']['Status'].get('StateChangeReason', 'unknown')
            logger.warning(f"Data transfer query {state}: {reason}")
            return []
        _time.sleep(2)
    else:
        logger.warning("Data transfer query timed out")
        return []

    rows = []
    paginator = athena.get_paginator('get_query_results')
    pages = list(paginator.paginate(QueryExecutionId=execution_id))
    if not pages or not pages[0].get('ResultSet', {}).get('Rows'):
        return []

    headers = [col['VarCharValue'] for col in pages[0]['ResultSet']['Rows'][0]['Data']]
    for page in pages:
        for row in page['ResultSet']['Rows'][1:]:
            values = [cell.get('VarCharValue', '') for cell in row['Data']]
            rows.append(dict(zip(headers, values)))
    return rows


# ── Opportunity scoring (pure Python, no API call) ────────────────────────────

def compute_opportunity_score(
    estimated_monthly_savings: float,
    effort: str,
    risk: str,
    urgency: str = 'MEDIUM',
) -> dict:
    """
    Compute a prioritization score for a cost optimization opportunity.
    Formula: score = savings × urgencyWeight / (effortWeight × riskWeight)
    Use this before calling save_enriched_finding to assign priority tier.

    Args:
        estimated_monthly_savings: Estimated monthly savings in USD.
        effort:                    Complexity to implement: LOW, MEDIUM, or HIGH.
        risk:                      Risk of negative impact: LOW, MEDIUM, or HIGH.
        urgency:                   How time-sensitive: LOW, MEDIUM, or HIGH.
                                   Use HIGH for anomalies/active waste,
                                   MEDIUM for rightsizing/SPs, LOW for architecture.

    Returns:
        Dict with score (float), priority (P0/P1/P2/P3), and rationale (str).
    """
    weights = {'LOW': 1, 'MEDIUM': 2, 'HIGH': 3}

    effort_w  = weights.get(effort.upper(),  2)
    risk_w    = weights.get(risk.upper(),    2)
    urgency_w = weights.get(urgency.upper(), 2)

    denominator = effort_w * risk_w
    if denominator == 0:
        denominator = 1

    score = (estimated_monthly_savings * urgency_w) / denominator

    if score >= 500:
        priority = 'P0'
    elif score >= 100:
        priority = 'P1'
    elif score >= 25:
        priority = 'P2'
    else:
        priority = 'P3'

    rationale = (
        f"${estimated_monthly_savings:.0f}/mo × urgency:{urgency}({urgency_w}) "
        f"/ (effort:{effort}({effort_w}) × risk:{risk}({risk_w})) = {score:.1f} → {priority}"
    )

    return {
        'score':    round(score, 2),
        'priority': priority,
        'rationale': rationale,
    }
