import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  AlertCircle,
  Clock3,
  Check,
  ChevronDown,
  CircleHelp,
  LoaderCircle,
  Mail,
  Shield,
  ShieldCheck,
  Trash2,
  UserRound,
  UserRoundPlus,
  Users,
  UserX,
} from 'lucide-react';
import {
  useCancelFacilityInvitation,
  getListFacilityMembersQueryKey,
  useInviteFacilityMember,
  useListFacilityMembers,
  useRemoveFacilityMember,
  useUpdateFacilityMember,
} from '@workspace/api-client-react';
import type { FacilityAssignableRole, FacilityInvitation, FacilityMember } from '@workspace/api-client-react';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { useForm } from 'react-hook-form';
import './facility-members-page.css';

const inviteSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(320, 'Email must be 320 characters or fewer.'),
  role: z.enum(['manager', 'operator']),
});

type InviteValues = z.infer<typeof inviteSchema>;
type Role = FacilityMember['role'];

function errorText(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function RoleMark({ role }: { role: Role }) {
  if (role === 'owner') return <ShieldCheck size={16} aria-hidden="true" />;
  if (role === 'manager') return <Shield size={16} aria-hidden="true" />;
  return <UserRound size={16} aria-hidden="true" />;
}

function roleLabel(role: Role) {
  return role[0].toUpperCase() + role.slice(1);
}

export default function FacilityMembersPage() {
  const client = useQueryClient();
  const membersQuery = useListFacilityMembers({
    query: { queryKey: getListFacilityMembersQueryKey() },
    request: { credentials: 'include' },
  });
  const inviteMember = useInviteFacilityMember({ request: { credentials: 'include' } });
  const cancelInvitation = useCancelFacilityInvitation({ request: { credentials: 'include' } });
  const updateMember = useUpdateFacilityMember({ request: { credentials: 'include' } });
  const removeMember = useRemoveFacilityMember({ request: { credentials: 'include' } });
  const [success, setSuccess] = useState('');
  const [actionError, setActionError] = useState('');
  const members = membersQuery.data?.members ?? [];
  const pendingInvitations = membersQuery.data?.pendingInvitations ?? [];
  const ownerCount = members.filter((member) => member.role === 'owner').length;
  const managerCount = members.filter((member) => member.role === 'manager').length;
  const operatorCount = members.filter((member) => member.role === 'operator').length;

  const form = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: 'operator' },
  });

  const afterWrite = () => {
    void client.invalidateQueries({ queryKey: getListFacilityMembersQueryKey() });
  };

  const onInvite = (values: InviteValues) => {
    setActionError('');
    setSuccess('');
    inviteMember.mutate({ data: { email: values.email.trim(), role: values.role } }, {
      onSuccess: (result) => {
        afterWrite();
        form.reset({ email: '', role: values.role });
        setSuccess(result.status === 'invited'
          ? `Invitation sent to ${result.email} as ${roleLabel(result.role)}.`
          : `${result.email} already has an account and was added as ${roleLabel(result.role)}.`);
      },
      onError: (error) => setActionError(errorText(error, 'The teammate could not be added. Please try again.')),
    });
  };

  const changeRole = (member: FacilityMember, role: FacilityAssignableRole) => {
    if (member.role === role) return;
    setActionError('');
    setSuccess('');
    updateMember.mutate({ memberId: member.id, data: { role } }, {
      onSuccess: () => {
        afterWrite();
        setSuccess(`${member.email || 'Teammate'} is now a ${roleLabel(role)}.`);
      },
      onError: (error) => setActionError(errorText(error, 'The role could not be changed. Please try again.')),
    });
  };

  const removeMemberById = (member: FacilityMember) => {
    if (!window.confirm(`Remove ${member.email || 'this teammate'} from the facility?`)) return;
    setActionError('');
    setSuccess('');
    removeMember.mutate({ memberId: member.id }, {
      onSuccess: () => {
        afterWrite();
        setSuccess(`${member.email || 'Teammate'} was removed from the facility.`);
      },
      onError: (error) => setActionError(errorText(error, 'The teammate could not be removed. Please try again.')),
    });
  };

  const cancelPendingInvitation = (invitation: FacilityInvitation) => {
    if (!window.confirm(`Cancel the invitation for ${invitation.email}? They will no longer get facility access from this invitation.`)) return;
    setActionError('');
    setSuccess('');
    cancelInvitation.mutate({ invitationId: invitation.id }, {
      onSuccess: () => {
        afterWrite();
        setSuccess(`The invitation for ${invitation.email} was cancelled.`);
      },
      onError: (error) => setActionError(errorText(error, 'The invitation could not be cancelled. Please try again.')),
    });
  };

  const writePending = inviteMember.isPending || cancelInvitation.isPending || updateMember.isPending || removeMember.isPending;

  return (
    <main className="workspace team-page" data-testid="page-facility-team">
      <div className="team-page-head">
        <div>
          <div className="eyebrow">Facility access</div>
          <h1>Team members</h1>
          <p className="page-subtitle">Keep the right people in step with the work on your floor.</p>
        </div>
        <div className="team-head-mark" aria-hidden="true"><Users size={20} /></div>
      </div>

      <section className="team-summary" aria-label="Team membership summary">
        <div className="team-summary-lead">
          <span className="team-summary-icon"><Users size={18} /></span>
          <div><strong data-testid="text-team-total">{members.length}</strong><span>people with facility access</span></div>
        </div>
        <div className="team-role-counts">
          <span data-testid="count-team-owner"><i className="role-dot role-dot-owner" />{ownerCount} {ownerCount === 1 ? 'owner' : 'owners'}</span>
          <span data-testid="count-team-manager"><i className="role-dot role-dot-manager" />{managerCount} {managerCount === 1 ? 'manager' : 'managers'}</span>
          <span data-testid="count-team-operator"><i className="role-dot role-dot-operator" />{operatorCount} {operatorCount === 1 ? 'operator' : 'operators'}</span>
        </div>
      </section>

      {success && <div className="team-feedback team-feedback-success" role="status" data-testid="status-team-success"><Check size={17} /><span>{success}</span></div>}
      {actionError && <div className="team-feedback team-feedback-error" role="alert" data-testid="error-team-action"><AlertCircle size={17} /><span>{actionError}</span></div>}

      <div className="team-layout">
        <section className="team-members-section" aria-labelledby="members-heading">
          <div className="team-section-head">
            <div><div className="eyebrow">Access roster</div><h2 id="members-heading">People at this facility</h2></div>
            {membersQuery.data && <span className="team-count" data-testid="text-team-member-count">{members.length} total</span>}
          </div>
          {membersQuery.isLoading && !membersQuery.data && (
            <div className="team-list-skeleton" aria-label="Loading team members" data-testid="loading-team-members">
              <div className="team-skeleton-row" /><div className="team-skeleton-row" /><div className="team-skeleton-row" />
            </div>
          )}
          {membersQuery.isError && !membersQuery.data && (
            <div className="team-query-error" role="alert" data-testid="error-team-load">
              <div className="team-error-icon"><AlertCircle size={20} /></div>
              <h3>Team roster unavailable</h3>
              <p>{errorText(membersQuery.error, 'Facility members could not be loaded. Check your access and try again.')}</p>
              <button className="button button-secondary" type="button" onClick={() => void membersQuery.refetch()} data-testid="button-retry-team">
                Try again
              </button>
            </div>
          )}
          {membersQuery.isError && membersQuery.data && (
            <div className="team-feedback team-feedback-error" role="status" data-testid="error-team-refresh">
              <AlertCircle size={17} /><span>Could not refresh the roster. Showing the last saved list.</span>
            </div>
          )}
          {membersQuery.data && members.length === 0 && pendingInvitations.length === 0 && (
            <div className="team-empty" data-testid="empty-team-members">
              <div className="team-empty-icon"><Users size={22} /></div>
              <h3>No teammates yet</h3>
              <p>Invite a manager or operator to give your facility its first shared access.</p>
            </div>
          )}
          {membersQuery.data && members.length > 0 && (
            <div className="team-member-list" role="list" data-testid="list-team-members">
              {members.map((member) => {
                const updatingThisMember = updateMember.isPending && updateMember.variables?.memberId === member.id;
                const removingThisMember = removeMember.isPending && removeMember.variables?.memberId === member.id;
                return (
                  <article className="team-member-row" role="listitem" key={member.id} data-testid={`row-team-member-${member.id}`}>
                    <div className={`team-avatar team-avatar-${member.role}`} aria-hidden="true">{(member.email?.[0] || 'U').toUpperCase()}</div>
                    <div className="team-member-identity">
                      <strong data-testid={`text-team-member-email-${member.id}`}>{member.email || 'Email unavailable'}</strong>
                      <span>Facility member</span>
                    </div>
                    <div className={`team-role-pill team-role-${member.role}`} data-testid={`status-team-member-role-${member.id}`}>
                      <RoleMark role={member.role} />{roleLabel(member.role)}
                    </div>
                    {member.role === 'owner' ? (
                      <div className="team-owner-note" data-testid={`text-owner-protected-${member.id}`}><ShieldCheck size={15} />Protected</div>
                    ) : (
                      <div className="team-member-controls">
                        <label className="sr-only" htmlFor={`team-role-${member.id}`}>Change role for {member.email || 'teammate'}</label>
                        <div className="team-role-select-wrap">
                          <select
                            id={`team-role-${member.id}`}
                            className="team-role-select"
                            value={member.role}
                            disabled={writePending || updatingThisMember || removingThisMember}
                            onChange={(event) => changeRole(member, event.target.value as FacilityAssignableRole)}
                            data-testid={`select-team-role-${member.id}`}
                          >
                            <option value="manager">Manager</option>
                            <option value="operator">Operator</option>
                          </select>
                          {updatingThisMember ? <LoaderCircle size={14} className="team-control-spinner" /> : <ChevronDown size={14} className="team-select-chevron" />}
                        </div>
                        <button
                          className="team-remove-button"
                          type="button"
                          aria-label={`Remove ${member.email || 'teammate'}`}
                          title="Remove from facility"
                          disabled={writePending}
                          onClick={() => removeMemberById(member)}
                          data-testid={`button-remove-team-member-${member.id}`}
                        >
                          {removingThisMember ? <LoaderCircle size={16} className="team-control-spinner" /> : <UserX size={16} />}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {membersQuery.data && pendingInvitations.length > 0 && (
            <PendingInvitationList
              invitations={pendingInvitations}
              disabled={writePending}
              cancellingInvitationId={cancelInvitation.variables?.invitationId}
              onCancel={cancelPendingInvitation}
            />
          )}
          <div className="team-roster-footnote"><CircleHelp size={14} /><span>Owners retain full facility control. Role changes apply across the shared workspace.</span></div>
        </section>

        <aside className="team-invite-panel">
          <div className="team-invite-topline"><span className="team-invite-icon"><UserRoundPlus size={19} /></span><span className="eyebrow">Add to your crew</span></div>
          <h2>Invite a teammate</h2>
          <p className="team-invite-copy">Send access to someone who helps keep production moving.</p>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onInvite)} className="team-invite-form" noValidate data-testid="form-invite-team-member">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem className="team-form-item">
                    <FormLabel className="team-form-label">Work email</FormLabel>
                    <FormControl>
                      <div className="team-input-wrap">
                        <Mail size={16} aria-hidden="true" />
                        <input
                          {...field}
                          type="email"
                          autoComplete="email"
                          placeholder="name@company.com"
                          maxLength={320}
                          className="team-input"
                          data-testid="input-team-invite-email"
                        />
                      </div>
                    </FormControl>
                    <FormDescription className="team-form-description">Use the email address they use to sign in.</FormDescription>
                    <FormMessage className="team-form-message" data-testid="error-team-invite-email" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem className="team-form-item">
                    <FormLabel className="team-form-label">Facility role</FormLabel>
                    <FormControl>
                      <select {...field} className="team-invite-select" data-testid="select-team-invite-role">
                        <option value="operator">Operator — runs production</option>
                        <option value="manager">Manager — coordinates the team</option>
                      </select>
                    </FormControl>
                    <FormDescription className="team-form-description">Owners can change this later.</FormDescription>
                  </FormItem>
                )}
              />
              <button className="button button-primary team-invite-submit" type="submit" disabled={writePending} data-testid="button-send-team-invite">
                {inviteMember.isPending ? <LoaderCircle size={16} className="spin" /> : <UserRoundPlus size={16} />}
                {inviteMember.isPending ? 'Adding teammate…' : 'Send invitation'}
              </button>
            </form>
          </Form>
          <div className="team-invite-note"><ShieldCheck size={16} /><span>Existing accounts are added right away. New teammates receive an email invitation.</span></div>
        </aside>
      </div>
    </main>
  );
}

function PendingInvitationList({
  invitations,
  disabled,
  cancellingInvitationId,
  onCancel,
}: {
  invitations: FacilityInvitation[];
  disabled: boolean;
  cancellingInvitationId?: string;
  onCancel: (invitation: FacilityInvitation) => void;
}) {
  return (
    <section className="team-pending-section" aria-labelledby="pending-invitations-heading" data-testid="list-pending-team-invitations">
      <div className="team-pending-heading">
        <div><div className="eyebrow">Awaiting sign-in</div><h3 id="pending-invitations-heading">Pending invitations</h3></div>
        <span className="team-count">{invitations.length} pending</span>
      </div>
      <div className="team-pending-list">
        {invitations.map((invitation) => (
          <article className="team-pending-row" key={invitation.id} data-testid={`row-team-invitation-${invitation.id}`}>
            <span className="team-pending-icon" aria-hidden="true"><Clock3 size={16} /></span>
            <span className="team-pending-email" data-testid={`text-team-invitation-email-${invitation.id}`}>{invitation.email}</span>
            <span className={`team-role-pill team-role-${invitation.role}`} data-testid={`status-team-invitation-role-${invitation.id}`}>{roleLabel(invitation.role)}</span>
            <span className="team-pending-expiry">Expires {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(invitation.expiresAt))}</span>
            <button
              className="team-cancel-invitation-button"
              type="button"
              aria-label={`Cancel invitation for ${invitation.email}`}
              title="Cancel invitation"
              disabled={disabled}
              onClick={() => onCancel(invitation)}
              data-testid={`button-cancel-team-invitation-${invitation.id}`}
            >
              {cancellingInvitationId === invitation.id
                ? <LoaderCircle size={15} className="team-control-spinner" />
                : <Trash2 size={15} />}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
