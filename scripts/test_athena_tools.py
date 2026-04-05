#!/usr/bin/env python3
"""
test_athena_tools.py
--------------------
Run all 5 Athena query tools against real CUR data in the linked account.

Prerequisites:
  1. CUR export enabled in AWS Billing with Athena integration (takes 24h)
  2. Glue crawler run at least once:
       aws glue start-crawler --name kostops-cur-crawler
  3. AWS credentials configured for the LINKED account
  4. uv or pip: pip install -r requirements.txt

Usage:
  # With default settings (last 30 days)
  python scripts/test_athena_tools.py

  # Custom date range
  python scripts/test_athena_tools.py --start 2026-03-01 --end 2026-04-01

  # Override environment
  CUR_BUCKET=kostops-cur-123456789012 \\
  ATHENA_WORKGROUP=kostops-workgroup \\
  GLUE_DATABASE=kostops_cur \\
  python scripts/test_athena_tools.py
"""

import os
import sys
import json
import argparse
import textwrap
from datetime import date, timedelta
from pathlib import Path

# Add repo root to path so tools/ imports work
sys.path.insert(0, str(Path(__file__).parent.parent))

# ── Config from env (set by CDK outputs or manually) ─────────────────────────
os.environ.setdefault('ATHENA_WORKGROUP', 'kostops-workgroup')
os.environ.setdefault('GLUE_DATABASE',   'kostops_cur')
os.environ.setdefault('CUR_TABLE',       'cur')
os.environ.setdefault('AWS_REGION',      'us-east-1')

# CUR_BUCKET must be set — it's the replicated bucket in the linked account
CUR_BUCKET = os.environ.get('CUR_BUCKET', '')
if not CUR_BUCKET:
    # Try to derive from AWS account ID
    try:
        import boto3
        account_id = boto3.client('sts').get_caller_identity()['Account']
        CUR_BUCKET = f'kostops-cur-{account_id}'
        os.environ['CUR_BUCKET'] = CUR_BUCKET
        print(f"[info] CUR_BUCKET not set — derived: {CUR_BUCKET}\n")
    except Exception as e:
        print(f"[error] Could not determine CUR_BUCKET: {e}")
        print("Set it explicitly: export CUR_BUCKET=kostops-cur-<your-account-id>")
        sys.exit(1)

from tools.athena_tools import (
    get_spend_by_service,
    get_spend_by_account,
    get_spend_by_tag,
    get_daily_spend_trend,
    get_top_cost_drivers,
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def header(title: str) -> None:
    width = 60
    print(f"\n{'─' * width}")
    print(f"  {title}")
    print(f"{'─' * width}")

def print_table(rows: list[dict], max_rows: int = 10) -> None:
    if not rows:
        print("  (no results)")
        return
    keys = list(rows[0].keys())
    col_widths = {k: max(len(k), max(len(str(r.get(k, ''))) for r in rows)) for k in keys}
    fmt = '  ' + '  '.join(f'{{:<{col_widths[k]}}}' for k in keys)
    print(fmt.format(*keys))
    print('  ' + '  '.join('─' * col_widths[k] for k in keys))
    for row in rows[:max_rows]:
        print(fmt.format(*[str(row.get(k, '')) for k in keys]))
    if len(rows) > max_rows:
        print(f"  ... and {len(rows) - max_rows} more rows")

def run_tool(name: str, fn, *args, **kwargs) -> list[dict]:
    print(f"\n[running] {name}({', '.join(list(args) + [f'{k}={v}' for k,v in kwargs.items()])})")
    try:
        results = fn(*args, **kwargs)
        print(f"[ok] {len(results)} row(s) returned")
        return results
    except Exception as e:
        print(f"[FAILED] {e}")
        return []

# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description='Test KostOps Athena tools against real CUR data')
    today  = date.today()
    parser.add_argument('--start', default=str(today.replace(day=1)),
                        help='Start date YYYY-MM-DD (default: first day of current month)')
    parser.add_argument('--end',   default=str(today + timedelta(days=1)),
                        help='End date YYYY-MM-DD exclusive (default: tomorrow)')
    parser.add_argument('--tag',   default='Environment',
                        help='Tag key to test get_spend_by_tag (default: Environment)')
    args = parser.parse_args()

    print(textwrap.dedent(f"""
    ╔══════════════════════════════════════════════╗
    ║        KostOps Athena Tools — Local Test     ║
    ╚══════════════════════════════════════════════╝
    CUR bucket  : {CUR_BUCKET}
    Workgroup   : {os.environ['ATHENA_WORKGROUP']}
    Database    : {os.environ['GLUE_DATABASE']}
    Table       : {os.environ['CUR_TABLE']}
    Region      : {os.environ['AWS_REGION']}
    Date range  : {args.start} → {args.end}
    """))

    results: dict[str, list] = {}

    # ── Tool 1: get_spend_by_service ──────────────────────────────────────────
    header("Tool 1 — get_spend_by_service")
    rows = run_tool('get_spend_by_service', get_spend_by_service,
                    args.start, args.end, limit=10)
    print_table(rows)
    results['spend_by_service'] = rows

    # ── Tool 2: get_spend_by_account ──────────────────────────────────────────
    header("Tool 2 — get_spend_by_account")
    rows = run_tool('get_spend_by_account', get_spend_by_account,
                    args.start, args.end)
    print_table(rows)
    results['spend_by_account'] = rows

    # ── Tool 3: get_spend_by_tag ──────────────────────────────────────────────
    header(f"Tool 3 — get_spend_by_tag (tag_key='{args.tag}')")
    rows = run_tool('get_spend_by_tag', get_spend_by_tag,
                    args.start, args.end, tag_key=args.tag)
    print_table(rows)
    results['spend_by_tag'] = rows

    # ── Tool 4: get_daily_spend_trend ─────────────────────────────────────────
    header("Tool 4 — get_daily_spend_trend")
    rows = run_tool('get_daily_spend_trend', get_daily_spend_trend,
                    args.start, args.end)
    print_table(rows)
    results['daily_trend'] = rows

    # ── Tool 5: get_top_cost_drivers ──────────────────────────────────────────
    header("Tool 5 — get_top_cost_drivers")
    rows = run_tool('get_top_cost_drivers', get_top_cost_drivers,
                    args.start, args.end, limit=10)
    print_table(rows)
    results['top_drivers'] = rows

    # ── Summary ───────────────────────────────────────────────────────────────
    header("Summary")
    passed = sum(1 for v in results.values() if v)
    total  = len(results)
    print(f"\n  {passed}/{total} tools returned data\n")

    if passed == total:
        print("  ✅ All tools working against real CUR data — Week 1 deliverable complete!")
    else:
        failed = [k for k, v in results.items() if not v]
        print(f"  ⚠️  No data from: {', '.join(failed)}")
        print("\n  Common causes:")
        print("  - Glue crawler not run yet (aws glue start-crawler --name kostops-cur-crawler)")
        print("  - CUR data not yet delivered (takes 24h after first enable)")
        print("  - Wrong GLUE_DATABASE or CUR_TABLE name — check Glue console")
        print("  - Date range has no billing data — try a wider range with --start/--end")

    print()

if __name__ == '__main__':
    main()
