"""
Billing Tools
-------------
Strands tools for payer-account billing APIs:
  Cost Explorer, Compute Optimizer, Budgets, Cost Optimization Hub.

All tools assume the payer cross-account role via payer_role.get_payer_session().
They must be called from the KostOps agent running in the linked account —
payer credentials are injected transparently by payer_role.py.

Why payer credentials?
  Cost Explorer, Compute Optimizer, Budgets, and Cost Optimization Hub only
  return consolidated data when called from the payer (management) account.
  Calling them from a linked account returns data for that account only.

Cost note:
  Cost Explorer API = $0.01 per API call. Tools are designed to batch data
  into a single call where possible. The agent is instructed not to repeat
  identical calls within a session.
"""

import os
import json
import logging
from datetime import date, timedelta
from typing import Optional
from strands import tool

logger     = logging.getLogger(__name__)
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')


def _ce():
    """Cost Explorer client with payer credentials."""
    from payer_role import get_payer_session
    return get_payer_session().client('ce', region_name='us-east-1')  # CE is global, always us-east-1


def _co():
    """Compute Optimizer client with payer credentials."""
    from payer_role import get_payer_session
    return get_payer_session().client('compute-optimizer', region_name=AWS_REGION)


def _budgets():
    """Budgets client with payer credentials."""
    from payer_role import get_payer_session
    import boto3
    # Need payer account ID for Budgets API
    sts = get_payer_session().client('sts')
    account_id = sts.get_caller_identity()['Account']
    client = get_payer_session().client('budgets', region_name=AWS_REGION)
    return client, account_id


def _coh():
    """Cost Optimization Hub client with payer credentials."""
    from payer_role import get_payer_session
    return get_payer_session().client('cost-optimization-hub', region_name=AWS_REGION)


def _default_dates(months_back: int = 1) -> tuple:
    """Return (start, end) ISO date strings for the last N months."""
    today = date.today()
    end   = today.replace(day=1).isoformat()
    # Go back N months
    start_month = today.month - months_back
    start_year  = today.year
    while start_month <= 0:
        start_month += 12
        start_year  -= 1
    start = date(start_year, start_month, 1).isoformat()
    return start, end


# ── Cost Explorer tools ───────────────────────────────────────────────────────

@tool
def get_cost_and_usage(
    start_date: str,
    end_date: str,
    granularity: str = 'MONTHLY',
    group_by: str = 'SERVICE',
) -> dict:
    """
    Get AWS cost and usage from Cost Explorer (payer account — consolidated view).

    Args:
        start_date:   Start date in YYYY-MM-DD format (inclusive).
        end_date:     End date in YYYY-MM-DD format (exclusive).
        granularity:  MONTHLY, DAILY, or HOURLY.
        group_by:     Dimension to group by: SERVICE, ACCOUNT, REGION, USAGE_TYPE.

    Returns:
        Dict with ResultsByTime: list of periods, each with Groups (name + amount).

    Cost: $0.01 per call — do not repeat identical calls within a session.
    """
    logger.info(f"get_cost_and_usage {start_date} → {end_date} by {group_by}")
    resp = _ce().get_cost_and_usage(
        TimePeriod={'Start': start_date, 'End': end_date},
        Granularity=granularity,
        Metrics=['UnblendedCost'],
        GroupBy=[{'Type': 'DIMENSION', 'Key': group_by}],
    )
    # Simplify the response for the agent
    results = []
    for period in resp['ResultsByTime']:
        groups = [
            {
                'name':  g['Keys'][0],
                'cost':  round(float(g['Metrics']['UnblendedCost']['Amount']), 2),
                'unit':  g['Metrics']['UnblendedCost']['Unit'],
            }
            for g in sorted(
                period['Groups'],
                key=lambda x: float(x['Metrics']['UnblendedCost']['Amount']),
                reverse=True,
            )
        ]
        results.append({
            'period': period['TimePeriod'],
            'total':  round(sum(g['cost'] for g in groups), 2),
            'groups': groups,
        })
    return {'results': results, 'granularity': granularity, 'group_by': group_by}


@tool
def get_cost_forecast(
    start_date: str,
    end_date: str,
    granularity: str = 'MONTHLY',
) -> dict:
    """
    Get AWS cost forecast for a future period from Cost Explorer.

    Args:
        start_date:  Start date for forecast (YYYY-MM-DD). Must be today or future.
        end_date:    End date for forecast (YYYY-MM-DD).
        granularity: MONTHLY or DAILY.

    Returns:
        Dict with total forecasted cost and confidence interval.
    """
    logger.info(f"get_cost_forecast {start_date} → {end_date}")
    resp = _ce().get_cost_forecast(
        TimePeriod={'Start': start_date, 'End': end_date},
        Metric='UNBLENDED_COST',
        Granularity=granularity,
    )
    return {
        'total': round(float(resp['Total']['Amount']), 2),
        'unit':  resp['Total']['Unit'],
        'mean_value': round(float(resp.get('ForecastResultsByTime', [{}])[0].get('MeanValue', 0) or 0), 2),
        'prediction_interval_lower': round(float(
            resp.get('ForecastResultsByTime', [{}])[0]
            .get('PredictionIntervalLowerBound', 0) or 0
        ), 2),
        'prediction_interval_upper': round(float(
            resp.get('ForecastResultsByTime', [{}])[0]
            .get('PredictionIntervalUpperBound', 0) or 0
        ), 2),
    }


@tool
def get_cost_comparison(
    baseline_start: str,
    baseline_end: str,
    comparison_start: str,
    comparison_end: str,
    group_by: str = 'SERVICE',
) -> dict:
    """
    Compare costs between two time periods to identify what changed.
    Returns services sorted by absolute cost change (biggest movers first).

    Args:
        baseline_start:   Start of the baseline period (YYYY-MM-DD).
        baseline_end:     End of the baseline period (YYYY-MM-DD).
        comparison_start: Start of the comparison period (YYYY-MM-DD).
        comparison_end:   End of the comparison period (YYYY-MM-DD).
        group_by:         SERVICE, ACCOUNT, or REGION.

    Returns:
        List of services with baseline cost, comparison cost, and delta.
    """
    logger.info(f"get_cost_comparison baseline={baseline_start}:{baseline_end} vs {comparison_start}:{comparison_end}")
    ce = _ce()

    def _fetch(start, end):
        resp = ce.get_cost_and_usage(
            TimePeriod={'Start': start, 'End': end},
            Granularity='MONTHLY',
            Metrics=['UnblendedCost'],
            GroupBy=[{'Type': 'DIMENSION', 'Key': group_by}],
        )
        totals = {}
        for period in resp['ResultsByTime']:
            for g in period['Groups']:
                key  = g['Keys'][0]
                cost = float(g['Metrics']['UnblendedCost']['Amount'])
                totals[key] = totals.get(key, 0) + cost
        return totals

    baseline   = _fetch(baseline_start, baseline_end)
    comparison = _fetch(comparison_start, comparison_end)
    all_keys   = set(baseline) | set(comparison)

    changes = []
    for key in all_keys:
        b = round(baseline.get(key, 0), 2)
        c = round(comparison.get(key, 0), 2)
        delta = round(c - b, 2)
        pct   = round((delta / b * 100) if b > 0 else 100.0, 1)
        changes.append({'name': key, 'baseline': b, 'comparison': c, 'delta': delta, 'pct_change': pct})

    changes.sort(key=lambda x: abs(x['delta']), reverse=True)
    return {
        'baseline_period':   f"{baseline_start} → {baseline_end}",
        'comparison_period': f"{comparison_start} → {comparison_end}",
        'changes':           changes,
    }


@tool
def get_anomalies(
    start_date: str,
    end_date: str,
    min_impact_dollars: float = 10.0,
) -> list:
    """
    Get cost anomalies detected by Cost Explorer for a time period.

    Args:
        start_date:           Start date (YYYY-MM-DD).
        end_date:             End date (YYYY-MM-DD).
        min_impact_dollars:   Minimum anomaly impact in USD to include (default $10).

    Returns:
        List of anomalies with service, impact, and root cause.
    """
    logger.info(f"get_anomalies {start_date} → {end_date} min=${min_impact_dollars}")
    resp = _ce().get_anomalies(
        DateInterval={'StartDate': start_date, 'EndDate': end_date},
        TotalImpact={'NumericOperator': 'GREATER_THAN_OR_EQUAL', 'StartValue': min_impact_dollars},
    )
    anomalies = []
    for a in resp.get('Anomalies', []):
        impact = a.get('Impact', {})
        anomalies.append({
            'anomaly_id':     a.get('AnomalyId', ''),
            'service':        a.get('DimensionValue', ''),
            'start_date':     a.get('AnomalyStartDate', ''),
            'end_date':       a.get('AnomalyEndDate', ''),
            'total_impact':   round(float(impact.get('TotalImpact', 0)), 2),
            'expected_spend': round(float(impact.get('TotalExpectedSpend', 0)), 2),
            'actual_spend':   round(float(impact.get('TotalActualSpend', 0)), 2),
            'root_causes':    a.get('RootCauses', []),
        })
    anomalies.sort(key=lambda x: x['total_impact'], reverse=True)
    return anomalies


@tool
def describe_anomaly_monitors() -> list:
    """
    List all Cost Anomaly Detection monitors in the payer account.
    Shows what services / accounts are being watched for spend anomalies.

    Returns:
        List of monitors with name, type, dimension, and creation date.
    """
    logger.info("describe_anomaly_monitors")
    resp = _ce().get_anomaly_monitors()
    monitors = []
    for m in resp.get('AnomalyMonitors', []):
        monitors.append({
            'monitor_arn':        m.get('MonitorArn', ''),
            'monitor_name':       m.get('MonitorName', ''),
            'monitor_type':       m.get('MonitorType', ''),
            'monitor_dimension':  m.get('MonitorDimension', ''),
            'creation_date':      m.get('CreationDate', ''),
            'last_evaluated_date': m.get('LastEvaluatedDate', ''),
            'total_impact':       round(float(m.get('TotalImpact', 0) or 0), 2),
        })
    return monitors


# ── Compute Optimizer ─────────────────────────────────────────────────────────

@tool
def get_rightsizing_recommendations() -> list:
    """
    Get EC2 rightsizing recommendations from Compute Optimizer (payer account).
    Returns instances that are over-provisioned with recommended instance types
    and estimated monthly savings.

    Returns:
        List of recommendations sorted by estimated monthly savings descending.
    """
    logger.info("get_rightsizing_recommendations")
    resp = _co().get_ec2_instance_recommendations(
        filters=[{'name': 'Finding', 'values': ['OVER_PROVISIONED']}],
        maxResults=50,
    )
    recs = []
    for r in resp.get('instanceRecommendations', []):
        current = r.get('currentInstanceType', '')
        options = r.get('recommendationOptions', [])
        if not options:
            continue
        best = options[0]
        savings_opp = best.get('savingsOpportunity', {})
        monthly_savings = float(
            savings_opp.get('estimatedMonthlySavings', {}).get('value', 0) or 0
        )
        recs.append({
            'instance_id':         r.get('instanceArn', '').split('/')[-1],
            'instance_name':       r.get('instanceName', ''),
            'account_id':          r.get('accountId', ''),
            'current_type':        current,
            'recommended_type':    best.get('instanceType', ''),
            'finding':             r.get('finding', ''),
            'cpu_max_pct':         round(float(
                next((m['value'] for m in r.get('utilizationMetrics', [])
                      if m['name'] == 'CPU' and m['statistic'] == 'MAXIMUM'), 0) or 0
            ), 1),
            'estimated_monthly_savings': round(monthly_savings, 2),
        })
    recs.sort(key=lambda x: x['estimated_monthly_savings'], reverse=True)
    return recs


# ── Budgets ───────────────────────────────────────────────────────────────────

@tool
def get_budget_list() -> list:
    """
    List all AWS Budgets in the payer account with current vs budgeted spend.

    Returns:
        List of budgets with name, type, budget amount, actual spend, and status.
    """
    logger.info("get_budget_list")
    client, account_id = _budgets()
    resp = client.describe_budgets(AccountId=account_id, MaxResults=50)
    budgets = []
    for b in resp.get('Budgets', []):
        spend      = b.get('CalculatedSpend', {})
        actual     = float(spend.get('ActualSpend', {}).get('Amount', 0) or 0)
        forecasted = float(spend.get('ForecastedSpend', {}).get('Amount', 0) or 0)
        limit      = float(b.get('BudgetLimit', {}).get('Amount', 0) or 0)
        budgets.append({
            'name':             b.get('BudgetName', ''),
            'type':             b.get('BudgetType', ''),
            'period':           b.get('TimeUnit', ''),
            'budget_amount':    round(limit, 2),
            'actual_spend':     round(actual, 2),
            'forecasted_spend': round(forecasted, 2),
            'pct_used':         round(actual / limit * 100, 1) if limit > 0 else 0,
            'over_budget':      actual > limit,
        })
    budgets.sort(key=lambda x: x['pct_used'], reverse=True)
    return budgets


@tool
def get_budget_performance(budget_name: str) -> dict:
    """
    Get historical performance for a specific budget (actual vs budgeted over time).

    Args:
        budget_name: The exact name of the budget (get names from get_budget_list).

    Returns:
        Dict with budget details and list of historical periods with actual vs budgeted spend.
    """
    logger.info(f"get_budget_performance {budget_name}")
    client, account_id = _budgets()
    resp = client.describe_budget_performance_history(
        AccountId=account_id,
        BudgetName=budget_name,
        MaxResults=12,  # Last 12 periods
    )
    history = []
    for entry in resp.get('BudgetedAndActualAmountsList', []):
        period = entry.get('TimePeriod', {})
        history.append({
            'start':          period.get('Start', ''),
            'end':            period.get('End', ''),
            'budgeted_amount': round(float(entry.get('BudgetedAmount', {}).get('Amount', 0) or 0), 2),
            'actual_amount':  round(float(entry.get('ActualAmount', {}).get('Amount', 0) or 0), 2),
        })
    return {'budget_name': budget_name, 'history': history}


# ── Cost Optimization Hub ─────────────────────────────────────────────────────

@tool
def get_cost_optimization_hub_recommendations(
    max_results: int = 20,
) -> list:
    """
    Get cost optimization recommendations from AWS Cost Optimization Hub.
    Covers EC2, RDS, ECS, Lambda, EBS and more across all linked accounts.

    Args:
        max_results: Maximum number of recommendations to return (default 20).

    Returns:
        List of recommendations sorted by estimated monthly savings descending.
    """
    logger.info(f"get_cost_optimization_hub_recommendations max={max_results}")
    try:
        resp = _coh().list_recommendations(
            filter={'actionTypes': [
                'Rightsize', 'Stop', 'Upgrade',
                'PurchaseSavingsPlans', 'PurchaseReservedInstances',
                'MigrateToGraviton',
            ]},
            orderBy={'dimension': 'EstimatedMonthlySavings', 'order': 'Descending'},
            maxResults=max_results,
        )
    except Exception as e:
        logger.warning(f"Cost Optimization Hub unavailable: {e}")
        return []

    recs = []
    for r in resp.get('items', []):
        recs.append({
            'recommendation_id':         r.get('recommendationId', ''),
            'account_id':                r.get('accountId', ''),
            'resource_type':             r.get('resourceType', ''),
            'resource_id':               r.get('resourceId', ''),
            'resource_arn':              r.get('resourceArn', ''),
            'action_type':               r.get('actionType', ''),
            'current_resource_type':     r.get('currentResourceType', ''),
            'recommended_resource_type': r.get('recommendedResourceType', ''),
            'estimated_monthly_savings': round(
                float(r.get('estimatedMonthlySavings', 0) or 0), 2
            ),
            'estimated_savings_pct':     round(
                float(r.get('estimatedSavingsPercentage', 0) or 0), 1
            ),
            'implementation_effort':     r.get('implementationEffort', ''),
            'restart_needed':            r.get('restartNeeded', False),
        })
    return recs


# ── Savings Plans ─────────────────────────────────────────────────────────────

@tool
def get_savings_plans_purchase_recommendation(
    savings_plans_type: str = 'COMPUTE_SP',
    term_in_years: str = 'ONE_YEAR',
    payment_option: str = 'NO_UPFRONT',
    lookback_period: str = 'SIXTY_DAYS',
) -> dict:
    """
    Get Savings Plans purchase recommendations from Cost Explorer.
    Shows how much you could save by committing to a Savings Plan.

    Args:
        savings_plans_type: COMPUTE_SP (most flexible) or EC2_INSTANCE_SP.
        term_in_years:      ONE_YEAR or THREE_YEARS.
        payment_option:     NO_UPFRONT, PARTIAL_UPFRONT, or ALL_UPFRONT.
        lookback_period:    SEVEN_DAYS, THIRTY_DAYS, or SIXTY_DAYS (default).

    Returns:
        Dict with recommended hourly commitment, estimated savings, and coverage details.
    """
    logger.info(f"get_savings_plans_purchase_recommendation type={savings_plans_type} term={term_in_years}")
    resp = _ce().get_savings_plans_purchase_recommendation(
        SavingsPlansType=savings_plans_type,
        TermInYears=term_in_years,
        PaymentOption=payment_option,
        LookbackPeriodInDays=lookback_period,
    )
    meta    = resp.get('Metadata', {})
    summary = resp.get('SavingsPlansPurchaseRecommendationSummary', {})
    recs    = resp.get('SavingsPlansPurchaseRecommendations', [])

    return {
        'savings_plans_type':           savings_plans_type,
        'term_in_years':                term_in_years,
        'payment_option':               payment_option,
        'lookback_period_days':         lookback_period,
        'generated_at':                 meta.get('GenerationTimestamp', ''),
        'estimated_roi':                summary.get('EstimatedROI', ''),
        'estimated_monthly_savings':    round(float(summary.get('EstimatedMonthlySavingsAmount', 0) or 0), 2),
        'estimated_savings_pct':        summary.get('EstimatedSavingsPercentage', ''),
        'current_on_demand_spend':      round(float(summary.get('CurrentOnDemandSpend', 0) or 0), 2),
        'recommended_hourly_commitment': round(float(summary.get('HourlyCommitmentToPurchase', 0) or 0), 4),
        'recommendation_count':         len(recs),
    }


# ── Utility tools ─────────────────────────────────────────────────────────────

@tool
def get_today_date() -> str:
    """
    Return today's date in YYYY-MM-DD format.
    Use this before constructing date ranges for cost queries so you always
    use the correct current date rather than guessing.

    Returns:
        Today's date as a string, e.g. "2026-04-05".
    """
    today = date.today().isoformat()
    logger.info(f"get_today_date → {today}")
    return today


@tool
def get_dimension_values(
    dimension: str,
    start_date: str,
    end_date: str,
) -> list:
    """
    Get all values for a given Cost Explorer dimension in a time period.
    Useful for discovering account IDs, regions, or service names present in billing data.

    Args:
        dimension:  SERVICE, LINKED_ACCOUNT, REGION, USAGE_TYPE, INSTANCE_TYPE, etc.
        start_date: Start date (YYYY-MM-DD).
        end_date:   End date (YYYY-MM-DD).

    Returns:
        Sorted list of dimension values (strings).
    """
    logger.info(f"get_dimension_values dimension={dimension} {start_date}→{end_date}")
    resp = _ce().get_dimension_values(
        TimePeriod={'Start': start_date, 'End': end_date},
        Dimension=dimension,
    )
    values = [entry['Value'] for entry in resp.get('DimensionValues', [])]
    return sorted(values)


@tool
def get_tag_values(
    tag_key: str,
    start_date: str,
    end_date: str,
) -> list:
    """
    Get all values used for a specific cost allocation tag in a time period.
    Useful for understanding how resources are tagged (e.g. all values of 'Environment').

    Args:
        tag_key:    The tag key to look up, e.g. "Environment", "Team", "Project".
        start_date: Start date (YYYY-MM-DD).
        end_date:   End date (YYYY-MM-DD).

    Returns:
        Sorted list of tag values found in billing data.
    """
    logger.info(f"get_tag_values tag_key={tag_key} {start_date}→{end_date}")
    resp = _ce().get_tags(
        TimePeriod={'Start': start_date, 'End': end_date},
        TagKey=tag_key,
    )
    return sorted(resp.get('Tags', []))
