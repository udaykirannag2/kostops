import type { LucideIcon } from 'lucide-react';
import {
  Eye,
  Target,
  Unplug,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';

/**
 * Primary navigation tree — single source of truth for sidebar + header titles.
 * Add new pages here; routes in `App.tsx` should stay in sync.
 */
export interface NavPage {
  /** Sidebar + document title */
  label: string;
  /** React Router path (absolute from app root) */
  path: string;
  /** Shown under the page title in the main header */
  description?: string;
  /** Hide this entry from viewers; admin-only pages and buttons. */
  adminOnly?: boolean;
}

export interface NavSection {
  /** Stable id for accordion state */
  id: string;
  label: string;
  icon: LucideIcon;
  children: NavPage[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id:    'cost-visibility',
    label: 'Cost Visibility',
    icon:  Eye,
    children: [
      {
        label:       'Billing Summary',
        path:        '/visibility/billing-summary',
        description: 'Invoice and blended spend by account, charge-type breakdown — last 13 months.',
      },
      {
        label:       'Compute',
        path:        '/visibility/compute',
        description: 'EC2, Lambda, ECS, EKS, and Fargate cost and usage trends.',
      },
      {
        label:       'Storage',
        path:        '/visibility/storage',
        description: 'S3, EBS, EFS, FSx, and Glacier combined storage costs.',
      },
      {
        label:       'AI & ML',
        path:        '/visibility/ai-ml',
        description: 'SageMaker, Bedrock, Rekognition, Comprehend, and other AI service costs.',
      },
      {
        label:       'Teams & Scopes',
        path:        '/visibility/scopes',
        description: 'Define teams, OUs, and custom account groups that budgets roll up to.',
      },
      {
        label:       'Budgets',
        path:        '/visibility/budgets',
        description: 'Set and version per-scope monthly budgets — inline edits create new versions.',
      },
      {
        label:       'Budget Dashboard',
        path:        '/visibility/budget-dashboard',
        description: 'Budget vs forecast by scope for the current period.',
      },
    ],
  },
  {
    id:    'optimization',
    label: 'Optimization',
    icon:  Target,
    children: [
      {
        label:       'Opportunities',
        path:        '/optimization/opportunities',
        description: 'Prioritized savings opportunities detected across your cloud footprint.',
      },
      {
        label:       'Coverage & Commitments',
        path:        '/optimization/coverage-commitments',
        description: 'RI/SP utilization, charge-type trends, and commitment cost breakdown.',
      },
      {
        label:       'Rightsizing & Waste',
        path:        '/optimization/rightsizing',
        description: 'Instance family costs, on-demand waste, and over-provisioned compute.',
      },
      {
        label:       'Savings Tracker',
        path:        '/optimization/savings-tracker',
        description: 'Realized and projected savings from actions taken in KostOps.',
      },
      {
        label:       'Recommendations',
        path:        '/optimization/recommendations',
        description: 'Rightsizing, idle resources, and service-specific optimization guidance.',
      },
    ],
  },
  {
    id:    'integrations',
    label: 'Integrations',
    icon:  Unplug,
    children: [
      {
        label:       'Cloud Accounts',
        path:        '/integrations/cloud-accounts',
        description: 'Linked AWS accounts, org structure, and ingestion health.',
      },
      {
        label:       'Data Sources',
        path:        '/integrations/data-sources',
        description: 'CUR, billing exports, and data pipelines feeding KostOps.',
      },
      {
        label:       'Destinations',
        path:        '/integrations/destinations',
        description: 'BI tools, warehouses, and downstream consumers of cost data.',
      },
      {
        label:       'Connectors',
        path:        '/integrations/connectors',
        description: 'Slack, Jira, PagerDuty, and other tool integrations for FinOps workflows.',
      },
    ],
  },
  {
    id:    'assistant',
    label: 'Assistant',
    icon:  Sparkles,
    children: [
      {
        label:       'Chat',
        path:        '/assistant/chat',
        description: 'Ask questions about spend, anomalies, and optimization in natural language.',
      },
      {
        label:       'Playbooks',
        path:        '/assistant/playbooks',
        description: 'Guided workflows for common FinOps tasks — audits, tagging, cleanup.',
      },
      {
        label:       'History',
        path:        '/assistant/history',
        description: 'Past assistant sessions and exported answers for your workspace.',
      },
    ],
  },
  {
    id:    'admin',
    label: 'Admin',
    icon:  ShieldCheck,
    children: [
      {
        label:       'Workspace',
        path:        '/admin/workspace',
        description: 'Workspace profile, regions, and default cost reporting preferences.',
      },
      {
        label:       'Users & Roles',
        path:        '/admin/users-roles',
        description: 'Who can view costs, approve changes, and manage integrations.',
        adminOnly:   true,
      },
      {
        label:       'Policies',
        path:        '/admin/policies',
        description: 'Guardrails for budgets, tagging standards, and automation rules.',
      },
      {
        label:       'Settings',
        path:        '/admin/settings',
        description: 'Product configuration, API access, and audit logging.',
      },
    ],
  },
];

/** Flat lookup: path → section + page */
const PATH_MAP: Map<string, { section: NavSection; page: NavPage }> = new Map();
for (const section of NAV_SECTIONS) {
  for (const page of section.children) {
    PATH_MAP.set(page.path, { section, page });
  }
}

export function resolveNav(pathname: string): { section: NavSection; page: NavPage } | null {
  return PATH_MAP.get(pathname) ?? null;
}

export function sectionIdForPath(pathname: string): string | null {
  const hit = resolveNav(pathname);
  if (hit) return hit.section.id;
  const first = pathname.split('/').filter(Boolean)[0];
  const id = {
    visibility:   'cost-visibility',
    optimization: 'optimization',
    integrations: 'integrations',
    assistant:    'assistant',
    admin:        'admin',
  }[first];
  return id ?? null;
}
