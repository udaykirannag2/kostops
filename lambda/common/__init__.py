"""
lambda/common
-------------
Shared helpers used by every KostOps API Lambda:

  roles      — Cognito-group based RBAC (admin / viewer)
  audit      — immutable mutation log (AuditEvents table)
  api_client — agent tools invoking the KostOps API with the caller's JWT
"""
