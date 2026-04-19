import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck, Eye, UserPlus, UserX, RefreshCw, Mail } from 'lucide-react';
import clsx from 'clsx';
import {
  listMembers, inviteMember, changeMemberRole, disableMember,
  type Member, type MemberRole,
} from '../../api/client';
import { useRole } from '../../auth/useRole';

const ROLE_PILL: Record<MemberRole, { label: string; className: string; icon: React.ReactNode }> = {
  admin:  { label: 'Admin',  className: 'bg-indigo-50 text-indigo-700 ring-indigo-200', icon: <ShieldCheck size={12} /> },
  viewer: { label: 'Viewer', className: 'bg-slate-50  text-slate-700  ring-slate-200',  icon: <Eye        size={12} /> },
};

export default function MembersPage() {
  const { isAdmin, loading: roleLoading, sub: selfSub } = useRole();

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [busySub, setBusySub] = useState<string | null>(null);

  const [inviteOpen,  setInviteOpen]  = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole,  setInviteRole]  = useState<MemberRole>('viewer');
  const [inviteBusy,  setInviteBusy]  = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listMembers();
      setMembers(data.members);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!roleLoading && isAdmin) load();
  }, [isAdmin, roleLoading, load]);

  async function handleRoleChange(m: Member, next: MemberRole) {
    if (m.role === next) return;
    setBusySub(m.sub);
    try {
      await changeMemberRole(m.username, next);
      setMembers((prev) => prev.map((x) => (x.sub === m.sub ? { ...x, role: next } : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change role');
    } finally {
      setBusySub(null);
    }
  }

  async function handleDisable(m: Member) {
    if (m.sub === selfSub) {
      setError("You can't disable your own account.");
      return;
    }
    if (!confirm(`Disable ${m.email}? They will no longer be able to sign in.`)) return;
    setBusySub(m.sub);
    try {
      await disableMember(m.username);
      setMembers((prev) => prev.map((x) => (x.sub === m.sub ? { ...x, enabled: false } : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable user');
    } finally {
      setBusySub(null);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setError('Enter a valid email');
      return;
    }
    setInviteBusy(true);
    try {
      await inviteMember(email, inviteRole);
      setInviteOpen(false);
      setInviteEmail('');
      setInviteRole('viewer');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite member');
    } finally {
      setInviteBusy(false);
    }
  }

  if (roleLoading) {
    return (
      <div className="flex items-center gap-2 p-8 text-slate-500">
        <Loader2 size={16} className="animate-spin" /> Loading…
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>Admin access required.</strong> Ask an existing admin to promote your account.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-500">
          {members.length} {members.length === 1 ? 'member' : 'members'} in this workspace
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={() => setInviteOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <UserPlus size={14} /> Invite member
          </button>
        </div>
      </div>

      {inviteOpen && (
        <form
          onSubmit={handleInvite}
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm space-y-3"
        >
          <div className="text-sm font-medium text-slate-900">Invite a new member</div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex-1 min-w-[240px]">
              <span className="text-xs text-slate-500">Email</span>
              <div className="relative mt-1">
                <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  className="w-full rounded-md border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-400"
                />
              </div>
            </label>
            <label>
              <span className="text-xs text-slate-500">Role</span>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as MemberRole)}
                className="mt-1 block rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
              >
                <option value="viewer">Viewer (read-only)</option>
                <option value="admin">Admin (read + write)</option>
              </select>
            </label>
            <button
              type="submit"
              disabled={inviteBusy}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {inviteBusy && <Loader2 size={14} className="animate-spin" />}
              Send invite
            </button>
            <button
              type="button"
              onClick={() => setInviteOpen(false)}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Cognito emails a temporary password. New members default to viewer until promoted.
          </p>
        </form>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  <Loader2 size={16} className="inline animate-spin" /> Loading members…
                </td>
              </tr>
            )}
            {!loading && members.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  No members yet. Invite your first teammate to get started.
                </td>
              </tr>
            )}
            {!loading && members.map((m) => {
              const pill = ROLE_PILL[m.role];
              const isSelf = m.sub === selfSub;
              return (
                <tr key={m.sub || m.username} className={clsx(!m.enabled && 'opacity-60')}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">
                      {m.email || m.username}
                      {isSelf && <span className="ml-2 text-xs text-slate-400">(you)</span>}
                    </div>
                    <div className="text-xs text-slate-400">{m.status}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={clsx(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1',
                      pill.className,
                    )}>
                      {pill.icon} {pill.label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={clsx(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      m.enabled
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-slate-100 text-slate-500',
                    )}>
                      {m.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <select
                        value={m.role}
                        disabled={busySub === m.sub || !m.enabled || isSelf}
                        onChange={(e) => handleRoleChange(m, e.target.value as MemberRole)}
                        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="admin">Admin</option>
                      </select>
                      <button
                        onClick={() => handleDisable(m)}
                        disabled={busySub === m.sub || !m.enabled || isSelf}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        title={isSelf ? "You can't disable your own account" : 'Disable user'}
                      >
                        <UserX size={12} /> Disable
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        Admins have full read + write across KostOps. Viewers can only read data and ask questions.
        Role changes take effect on the user's next sign-in (JWT refresh within the hour).
      </p>
    </div>
  );
}
