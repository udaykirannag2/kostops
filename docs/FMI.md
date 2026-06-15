# FinOps Maturity Index (FMI)

> A single 0–100 score per business unit, team, and cloud platform that makes cloud financial health as readable as a credit score.

> **FMI is an original KostOps framework.** It is distinct from the Apptio/IBM COIN metric — see [disambiguation](#disambiguation-fmi-vs-apptio-coin) below.

---

## Disambiguation: FMI vs Apptio COIN

These are two different metrics. Both are useful. KostOps tracks both.

### Apptio COIN — Cost Optimization Index Number

COIN is an established FinOps KPI defined by Apptio (IBM). Formula:

```
COIN = Optimization Opportunities ($) / Total Amortized Spend ($)
```

**Lower is better.** A COIN of 0.25 means 25% of spend is identified waste. The target is typically ≤20%.

| Example | Calculation | Result |
|---|---|---|
| OptumRx: $3.8M spend, $760K in opportunities | 760K / 3.8M | COIN = 0.20 ✅ (at target) |
| OptumHealth: $4.2M spend, $1.26M in opportunities | 1.26M / 4.2M | COIN = 0.30 ⚠️ (above target) |

Apptio recommends qualifying standards alongside COIN:
- **Standard 1**: Each BU must maintain COIN ≤ 20% to be compliant
- **Standard 2**: Total opportunity must be < $5K regardless of COIN ratio (prevents ignoring large-spend low-ratio BUs)
- **Standard 3**: Standards 1 & 2 don't apply where total spend < $1K (prevents noise from tiny BUs)
- **Standard 4**: Declined optimization opportunities are removed from the numerator

> Reference: [FinOps KPI — What is COIN and How do I use it?](https://community.ibm.com/community/user/blogs/apptio-community-member/2024/09/26/finops-kpi-what-is-coin-and-how-do-i-use-it) — Kenny Shepard, Apptio (IBM), September 2024

---

### KostOps FMI — FinOps Maturity Index

FMI is an **original KostOps framework**. It measures *maturity behaviours*, not just waste ratio.

**Higher is better.** A score of 84 means a BU has strong visibility, is acting on opportunities, innovating, and governing well.

| | Apptio COIN | KostOps FMI |
|---|---|---|
| What it measures | Waste as % of spend | Maturity of FinOps behaviour |
| Direction | Lower = better | Higher = better |
| Range | 0.0 → ∞ (ratio) | 0 → 100 (index) |
| Components | Single ratio | Four components: F·M·I·(+N) |
| Cadence | Monthly typical | Daily automated |
| Audience | FinOps team + finance | All stakeholders incl. engineering teams and exec |

**Both metrics are complementary.** A BU can have a good FMI score (strong maturity behaviours) but still have a high COIN ratio if spend is growing fast. The combination tells the full story.

---

## Why FMI?

Raw cloud spend numbers don't drive executive action. A BU spending $4M/month doesn't tell you if that's good or bad. The FMI score answers the question executives actually care about: **are we getting better or worse at managing cloud spend?**

Like a credit score, FMI:
- Converts complex behavior into a single number anyone can understand
- Enables comparison across teams and BUs
- Tracks trend over time — direction matters as much as level
- Creates urgency without requiring CFO-level cloud expertise

---

## Score Bands

| Score | Band | Color | Meaning |
|---|---|---|---|
| 80–100 | Optimized | 🟢 | FinOps excellence. Peer benchmark standard. |
| 60–79 | Established | 🔵 | Good practice. Continuous improvement in place. |
| 40–59 | Developing | 🟠 | Active optimization program needed. |
| 0–39 | Critical | 🔴 | Immediate intervention required. |

---

## Component Breakdown

```mermaid
pie title FMI Component Weights
    "C — Cost Visibility" : 25
    "O — Optimization Realized" : 35
    "I — Innovation Adoption" : 20
    "N — Normalize Governance" : 20
```

### C — Cost Visibility (25 points)

*Can we see where the money is going?*

| Sub-metric | Weight | Measurement |
|---|---|---|
| Tag completeness | 40% | % of resources with all required Optum tags present |
| Spend allocation | 30% | % of total spend allocated to a known BU/product (vs "dark spend") |
| Anomaly coverage | 30% | % of resources enrolled in anomaly detection monitoring |

**Example**: 85% tag compliance + 92% spend allocated + 100% anomaly coverage → C = 21.2 / 25

---

### O — Optimization Realized (35 points)

*Are we actually fixing the waste we find?*

This is the hardest component to inflate — it requires real action, not just identifying problems.

| Sub-metric | Weight | Measurement |
|---|---|---|
| Idle resource remediation rate | 40% | % of identified idle resources addressed within 30 days |
| RI/SP coverage vs recommended | 30% | Actual coverage ÷ KostOps-recommended coverage |
| Rightsizing actions completed | 30% | Rightsizing actions taken ÷ recommendations made in last 90 days |

**Example**: 45% idle remediation + 78% RI coverage + 60% rightsizing → O = 19.6 / 35

---

### I — Innovation Adoption (20 points)

*Are we using cloud efficiently, not just cheaply?*

| Sub-metric | Weight | Measurement |
|---|---|---|
| Managed/serverless % | 40% | % of workloads on managed services vs self-managed EC2/VM |
| Automation rate | 30% | % of optimization actions executed without human touch (auto-approve threshold met) |
| AI/ML service adoption | 30% | AI/ML spend as % of total compute spend |

**Example**: 38% serverless + 25% automation + 15% AI spend → I = 13.2 / 20

---

### N — Normalize Governance (20 points)

*Are we staying within budget and improving unit economics?*

| Sub-metric | Weight | Measurement |
|---|---|---|
| Budget adherence | 40% | 1 - max(0, (actual - forecast) / forecast). Penalizes overruns. |
| Unit cost trend | 30% | $/claim or $/member-month. Decreasing = good. Uses 90-day regression slope. |
| Policy violation rate | 30% | 1 - (violations / total resources). Tagging, naming, approved regions. |

**Example**: 8% budget overrun + unit cost flat + 3% violation rate → N = 14.1 / 20

---

## Granularity

FMI scores are computed at three levels daily:

```mermaid
graph TD
    E[Enterprise Total\nweighted avg of BU scores]
    E --> OH[OptumHealth\n72/100]
    E --> OR[OptumRx\n58/100]
    E --> OI[OptumInsight\n84/100]
    E --> SS[Shared Services\n65/100]
    
    OH --> T1[Claims Processing\n91/100]
    OH --> T2[Patient Portal\n88/100]
    OH --> T3[Billing Services\n72/100]
    
    OR --> T4[Pharmacy Backend\n85/100]
    OR --> T5[Analytics Platform\n43/100]
```

---

## Storage Schema

```sql
-- DynamoDB table: optum-coin-scores
-- Partition key: bu_id#cloud
-- Sort key: score_date (YYYY-MM-DD)

{
  "pk": "optumrx#all",
  "sk": "2025-06-15",
  "score": 58,
  "components": {
    "C": 14.2,
    "O": 20.8,
    "I": 11.1,
    "N": 11.9
  },
  "previous_score": 60,
  "trend": -2,
  "top_opportunity": {
    "signal": "SNOWFLAKE_IDLE_WAREHOUSE",
    "savings_usd": 180000
  }
}
```

---

## Using FMI in Executive Communication

### Monthly Business Review (MBR) scorecard

```
OptumHealth   ████████████████░░░░  72/100  ↑ +4 pts
OptumRx       ████████████░░░░░░░░  58/100  ↓ -2 pts  ⚠️ Action needed
OptumInsight  █████████████████░░░  84/100  ↑ +6 pts  ✅ Best practice
Shared Svcs   █████████████░░░░░░░  65/100  → 0 pts
```

### QBR narrative framing

> *"OptumRx dropped 2 points this quarter to 58 (Developing). The primary drag is the O-component at 21/35 — only 31% of identified optimization opportunities were acted on in 30 days. Two root causes: (1) Snowflake idle warehouse cleanup awaiting team lead approval for 45 days, (2) EC2 rightsizing workflow blocked by missing CMDB owner tags. Recommended actions: unblock Snowflake approval (recovers $180K/yr) and run a tagging sprint to fix owner attribution."*
