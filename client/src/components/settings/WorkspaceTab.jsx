import { useState } from 'react';
import { Upload, UserPlus, Trash2, Save, Building2 } from 'lucide-react';

export default function WorkspaceTab() {
  const [workspace, setWorkspace] = useState({ name: 'Mineblock LLC', logo: null });
  const [invite, setInvite] = useState({ email: '', role: 'member' });
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);

  const [members, setMembers] = useState([
    { id: 1, name: 'John Doe', email: 'john@mineblock.io', role: 'owner', status: 'active' },
    { id: 2, name: 'Jane Smith', email: 'jane@mineblock.io', role: 'admin', status: 'active' },
    { id: 3, name: 'Bob Wilson', email: 'bob@mineblock.io', role: 'member', status: 'active' },
    { id: 4, name: 'Alice Brown', email: 'alice@mineblock.io', role: 'member', status: 'pending' },
  ]);

  const roles = ['owner', 'admin', 'member', 'viewer'];

  const handleSave = async () => {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 800));
    setSaving(false);
  };

  const handleInvite = () => {
    if (!invite.email) return;
    setMembers([
      ...members,
      {
        id: Date.now(),
        name: invite.email.split('@')[0],
        email: invite.email,
        role: invite.role,
        status: 'pending',
      },
    ]);
    setInvite({ email: '', role: 'member' });
  };

  const handleRemove = (id) => {
    setMembers(members.filter((m) => m.id !== id));
    setConfirmRemove(null);
  };

  const handleLogoUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {};
    input.click();
  };

  const roleColors = {
    owner: 'bg-purple-500/20 text-purple-400',
    admin: 'bg-accent-muted text-accent-text',
    member: 'bg-white/[0.06] text-white/60',
    viewer: 'bg-white/[0.04] text-white/40',
  };

  const statusColors = {
    active: 'bg-emerald-500/20 text-emerald-400',
    pending: 'bg-yellow-500/20 text-yellow-400',
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Workspace</h2>
        <p className="text-sm text-white/40">Manage your workspace settings and team members</p>
      </div>

      {/* Workspace Info */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6">
        <h3 className="text-sm font-semibold text-white mb-5">Workspace Details</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-white/70 mb-2">Workspace Name</label>
            <input
              type="text"
              value={workspace.name}
              onChange={(e) => setWorkspace({ ...workspace, name: e.target.value })}
              className="w-full px-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-sm
                focus:outline-none focus:border-white/[0.2] transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-white/70 mb-2">Workspace Logo</label>
            <button
              onClick={handleLogoUpload}
              className="flex items-center gap-3 px-4 py-2.5 bg-white/[0.04] border border-dashed border-white/[0.12] rounded-lg
                text-white/40 text-sm hover:bg-white/[0.06] hover:border-white/[0.2] transition-colors cursor-pointer w-full"
            >
              <div className="w-8 h-8 bg-white/[0.06] rounded flex items-center justify-center">
                <Building2 className="w-4 h-4 text-white/30" />
              </div>
              <div className="text-left">
                <p className="text-white/60 text-sm">Upload logo</p>
                <p className="text-white/30 text-xs">PNG, SVG up to 1MB</p>
              </div>
              <Upload className="w-4 h-4 ml-auto" />
            </button>
          </div>
        </div>
        <div className="mt-5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg
              transition-colors disabled:opacity-50 cursor-pointer"
          >
            {saving ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saving ? 'Saving...' : 'Save Workspace'}
          </button>
        </div>
      </div>

      {/* Invite Member */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6">
        <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-white/50" />
          Invite Member
        </h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="email"
            value={invite.email}
            onChange={(e) => setInvite({ ...invite, email: e.target.value })}
            placeholder="colleague@company.com"
            className="flex-1 px-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-sm
              focus:outline-none focus:border-white/[0.2] transition-colors placeholder-white/20"
          />
          <select
            value={invite.role}
            onChange={(e) => setInvite({ ...invite, role: e.target.value })}
            className="px-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-sm
              focus:outline-none focus:border-white/[0.2] appearance-none cursor-pointer min-w-[120px]"
          >
            <option value="admin" className="bg-[#111]">Admin</option>
            <option value="member" className="bg-[#111]">Member</option>
            <option value="viewer" className="bg-[#111]">Viewer</option>
          </select>
          <button
            onClick={handleInvite}
            disabled={!invite.email}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg
              transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <UserPlus className="w-4 h-4" />
            Send Invite
          </button>
        </div>
      </div>

      {/* Team Members */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06]">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="text-sm font-semibold text-white">Team Members ({members.length})</h3>
        </div>
        <div className="divide-y divide-white/[0.04]">
          {members.map((member) => (
            <div key={member.id} className="flex items-center justify-between px-6 py-4 hover:bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-white/[0.06] flex items-center justify-center text-sm font-medium text-white/60">
                  {member.name.split(' ').map((n) => n[0]).join('')}
                </div>
                <div>
                  <p className="text-sm text-white">{member.name}</p>
                  <p className="text-xs text-white/40">{member.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`px-2 py-0.5 text-[10px] font-semibold uppercase rounded ${roleColors[member.role]}`}>
                  {member.role}
                </span>
                <span className={`px-2 py-0.5 text-[10px] font-medium rounded capitalize ${statusColors[member.status]}`}>
                  {member.status}
                </span>
                {member.role !== 'owner' && (
                  <>
                    {confirmRemove === member.id ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleRemove(member.id)}
                          className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors cursor-pointer"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setConfirmRemove(null)}
                          className="px-2.5 py-1 text-xs bg-white/[0.06] hover:bg-white/[0.1] text-white/60 rounded transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmRemove(member.id)}
                        className="p-1.5 text-white/20 hover:text-red-400 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
