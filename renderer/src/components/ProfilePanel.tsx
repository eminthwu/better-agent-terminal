import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { parseConnectionUrl } from '../utils/connection-url'
import { host } from '../host-api'

interface ProfileEntry {
  id: string
  name: string
  type: 'local' | 'remote'
  remoteHost?: string
  remotePort?: number
  remoteToken?: string
  remoteFingerprint?: string
  remoteProfileId?: string
  remoteProfileName?: string
  sshTarget?: string
  createdAt: number
  updatedAt: number
}

interface RemoteProfileOption {
  id: string
  name: string
  type: string
}

interface ProfilePanelProps {
  onClose: () => void
  onSwitch?: (profileId: string) => void  // deprecated, kept for compat
  onSwitchNewWindow: (profileId: string) => void
  onProfileRenamed?: (profileId: string, newName: string) => void
}

export function ProfilePanel({ onClose, onSwitchNewWindow, onProfileRenamed }: ProfilePanelProps) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<ProfileEntry[]>([])
  const [activeProfileIds, setActiveProfileIds] = useState<string[]>(['default'])
  const [windowProfileId, setWindowProfileId] = useState<string | null>(null)
  const [creating, setCreating] = useState<'local' | 'remote' | false>(false)
  const [newName, setNewName] = useState('')
  const [remoteHost, setRemoteHost] = useState('')
  const [remotePort, setRemotePort] = useState('9876')
  const [remoteToken, setRemoteToken] = useState('')
  const [remoteFingerprint, setRemoteFingerprint] = useState('')
  const [remoteSshTarget, setRemoteSshTarget] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editingRemoteId, setEditingRemoteId] = useState<string | null>(null)
  const [editRemoteName, setEditRemoteName] = useState('')
  const [editRemoteHost, setEditRemoteHost] = useState('')
  const [editRemotePort, setEditRemotePort] = useState('')
  const [editRemoteToken, setEditRemoteToken] = useState('')
  const [editRemoteFingerprint, setEditRemoteFingerprint] = useState('')
  const [editRemoteSshTarget, setEditRemoteSshTarget] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, 'ok' | 'fail' | 'testing'>>({})
  const [remoteProfiles, setRemoteProfiles] = useState<RemoteProfileOption[]>([])
  const [selectedRemoteProfileId, setSelectedRemoteProfileId] = useState<string>('')
  const [fetchingRemoteProfiles, setFetchingRemoteProfiles] = useState(false)
  const [remoteProfileError, setRemoteProfileError] = useState<string>('')
  // For editing existing remote profile's target
  const [editRemoteProfiles, setEditRemoteProfiles] = useState<RemoteProfileOption[]>([])
  const [editSelectedRemoteProfileId, setEditSelectedRemoteProfileId] = useState<string>('')
  const [editFetchingRemoteProfiles, setEditFetchingRemoteProfiles] = useState(false)
  const [editRemoteProfileError, setEditRemoteProfileError] = useState<string>('')
  const [siblingSourceId, setSiblingSourceId] = useState<string | null>(null)
  const [siblingProfiles, setSiblingProfiles] = useState<RemoteProfileOption[]>([])
  const [siblingLoading, setSiblingLoading] = useState(false)
  const [siblingError, setSiblingError] = useState('')
  const createInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  const [remoteActiveByLocalId, setRemoteActiveByLocalId] = useState<Record<string, boolean>>({})

  const loadProfiles = useCallback(async () => {
    const result = await host.profile.listLocal()
    setProfiles(result.profiles)
    setActiveProfileIds(result.activeProfileIds)
    const wpId = await host.app.getWindowProfile()
    setWindowProfileId(wpId)

    // Fan out: query each unique remote target for its active profile ids,
    // so remote-alias entries reflect their REAL state on the target server.
    const remoteEntries = result.profiles.filter(p =>
      p.type === 'remote' && p.remoteHost && p.remoteToken && p.remoteFingerprint
    )
    if (remoteEntries.length === 0) {
      setRemoteActiveByLocalId({})
      return
    }
    const targetMap = new Map<string, { host: string; port: number; token: string; fingerprint: string; profiles: typeof remoteEntries }>()
    for (const p of remoteEntries) {
      const key = `${p.remoteHost}|${p.remotePort || 9876}|${p.remoteToken}|${p.remoteFingerprint}`
      const entry = targetMap.get(key)
      if (entry) entry.profiles.push(p)
      else targetMap.set(key, {
        host: p.remoteHost!,
        port: p.remotePort || 9876,
        token: p.remoteToken!,
        fingerprint: p.remoteFingerprint!,
        profiles: [p],
      })
    }
    const settled = await Promise.allSettled(
      Array.from(targetMap.values()).map(async target => {
        const res = await host.remote.listProfiles(target.host, target.port, target.token, target.fingerprint)
        if ('error' in res) return { profiles: target.profiles, activeIds: [] as string[] }
        return { profiles: target.profiles, activeIds: res.activeProfileIds }
      })
    )
    const map: Record<string, boolean> = {}
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue
      const { profiles: ps, activeIds } = s.value
      for (const p of ps) {
        const targetId = p.remoteProfileId || 'default'
        map[p.id] = activeIds.includes(targetId)
      }
    }
    setRemoteActiveByLocalId(map)
  }, [])

  useEffect(() => {
    loadProfiles()
  }, [loadProfiles])

  useEffect(() => {
    return host.profile.onChanged(() => {
      void loadProfiles()
    })
  }, [loadProfiles])

  useEffect(() => {
    if (creating && createInputRef.current) {
      createInputRef.current.focus()
    }
  }, [creating])

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (creating) { setCreating(false); setNewName('') }
        else if (editingId) { setEditingId(null); setEditValue('') }
        else if (editingRemoteId) { setEditingRemoteId(null) }
        else if (confirmDelete) { setConfirmDelete(null) }
        else if (siblingSourceId) { setSiblingSourceId(null); setSiblingProfiles([]); setSiblingError('') }
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [creating, editingId, confirmDelete, siblingSourceId, onClose])

  // Resolve where to dial: through a client-side SSH forward when the
  // profile (or the form) names an sshTarget, otherwise host:port directly.
  const resolveDialEndpoint = async (spec: { profileId?: string; sshTarget?: string; remoteHost: string; remotePort: number }) => {
    if (!spec.profileId && !spec.sshTarget) return { host: spec.remoteHost, port: spec.remotePort }
    const endpoint = await host.remoteTunnel.ensure(spec.profileId ? { profileId: spec.profileId } : {
      sshTarget: spec.sshTarget, remoteHost: spec.remoteHost, remotePort: spec.remotePort,
    })
    if (!endpoint.ready) {
      throw new Error([endpoint.error || 'ssh tunnel not ready', endpoint.output].filter(Boolean).join('\n'))
    }
    return { host: endpoint.host, port: endpoint.port }
  }

  const fetchRemoteProfileList = async (remoteHost: string, port: number, token: string, fingerprint: string, tunnel?: { profileId?: string; sshTarget?: string }): Promise<RemoteProfileOption[]> => {
    const dial = await resolveDialEndpoint({ ...tunnel, remoteHost, remotePort: port })
    const result = await host.remote.listProfiles(dial.host, dial.port, token, fingerprint)
    if ('error' in result) throw new Error(result.error)
    return result.profiles
  }

  const handleFetchRemoteProfiles = async () => {
    if (!remoteHost.trim() || !remoteToken.trim() || !remoteFingerprint.trim()) return
    setFetchingRemoteProfiles(true)
    setRemoteProfileError('')
    try {
      const profiles = await fetchRemoteProfileList(remoteHost.trim(), parseInt(remotePort) || 9876, remoteToken.trim(), remoteFingerprint.trim(), { sshTarget: remoteSshTarget.trim() || undefined })
      setRemoteProfiles(profiles)
      // Auto-select default or first
      const defaultP = profiles.find(p => p.id === 'default') || profiles[0]
      setSelectedRemoteProfileId(defaultP?.id || '')
    } catch (err) {
      setRemoteProfileError(err instanceof Error ? err.message : String(err))
      setRemoteProfiles([])
    } finally {
      setFetchingRemoteProfiles(false)
    }
  }

  const handleCreate = async () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    if (creating === 'remote') {
      if (!remoteHost.trim() || !remoteToken.trim() || !remoteFingerprint.trim()) return
      if (!selectedRemoteProfileId) return
      await host.profile.create(trimmed, {
        type: 'remote',
        remoteHost: remoteHost.trim(),
        remotePort: parseInt(remotePort) || 9876,
        remoteToken: remoteToken.trim(),
        remoteFingerprint: remoteFingerprint.trim(),
        remoteProfileId: selectedRemoteProfileId,
        remoteProfileName: remoteProfiles.find(p => p.id === selectedRemoteProfileId)?.name,
        sshTarget: remoteSshTarget.trim() || undefined,
      })
    } else {
      await host.profile.create(trimmed)
    }
    setCreating(false)
    setNewName('')
    setRemoteHost('')
    setRemotePort('9876')
    setRemoteToken('')
    setRemoteFingerprint('')
    setRemoteSshTarget('')
    setRemoteProfiles([])
    setSelectedRemoteProfileId('')
    loadProfiles()
  }

  const handleRename = async (profileId: string) => {
    const trimmed = editValue.trim()
    if (!trimmed) { setEditingId(null); return }
    await host.profile.rename(profileId, trimmed)
    setEditingId(null)
    setEditValue('')
    loadProfiles()
    onProfileRenamed?.(profileId, trimmed)
  }

  const handleStartEditRemote = (profile: ProfileEntry) => {
    setEditingRemoteId(profile.id)
    setEditRemoteName(profile.name)
    setEditRemoteHost(profile.remoteHost || '')
    setEditRemotePort(String(profile.remotePort || 9876))
    setEditRemoteToken(profile.remoteToken || '')
    setEditRemoteFingerprint(profile.remoteFingerprint || '')
    setEditRemoteSshTarget(profile.sshTarget || '')
    setEditRemoteProfiles([])
    setEditSelectedRemoteProfileId(profile.remoteProfileId || '')
    setEditRemoteProfileError('')
  }

  const handleFetchEditRemoteProfiles = async () => {
    if (!editRemoteHost.trim() || !editRemoteToken.trim() || !editRemoteFingerprint.trim()) return
    setEditFetchingRemoteProfiles(true)
    setEditRemoteProfileError('')
    try {
      const profiles = await fetchRemoteProfileList(editRemoteHost.trim(), parseInt(editRemotePort) || 9876, editRemoteToken.trim(), editRemoteFingerprint.trim(), { sshTarget: editRemoteSshTarget.trim() || undefined })
      setEditRemoteProfiles(profiles)
      // Keep current selection if still valid, else auto-select
      if (!profiles.some(p => p.id === editSelectedRemoteProfileId)) {
        const defaultP = profiles.find(p => p.id === 'default') || profiles[0]
        setEditSelectedRemoteProfileId(defaultP?.id || '')
      }
    } catch (err) {
      setEditRemoteProfileError(err instanceof Error ? err.message : String(err))
      setEditRemoteProfiles([])
    } finally {
      setEditFetchingRemoteProfiles(false)
    }
  }

  const handleSaveRemote = async (profileId: string) => {
    const remoteHostValue = editRemoteHost.trim()
    const token = editRemoteToken.trim()
    const fingerprint = editRemoteFingerprint.trim()
    if (!remoteHostValue || !token || !fingerprint) return
    const name = editRemoteName.trim()
    const source = profiles.find(p => p.id === profileId)
    if (name && source && name !== source.name) {
      await host.profile.rename(profileId, name)
      onProfileRenamed?.(profileId, name)
    }
    await host.profile.update(profileId, {
      remoteHost: remoteHostValue,
      remotePort: parseInt(editRemotePort) || 9876,
      remoteToken: token,
      remoteFingerprint: fingerprint,
      remoteProfileId: editSelectedRemoteProfileId || undefined,
      // Only refresh the cached name when we have the fetched profile list;
      // otherwise leave the stored name untouched (undefined => unchanged).
      remoteProfileName: editRemoteProfiles.find(p => p.id === editSelectedRemoteProfileId)?.name,
      // Empty string clears the SSH target on the host side.
      sshTarget: editRemoteSshTarget.trim(),
    })
    setEditingRemoteId(null)
    setEditRemoteProfiles([])
    loadProfiles()
  }

  const handleDelete = async (profileId: string) => {
    await host.profile.delete(profileId)
    setConfirmDelete(null)
    loadProfiles()
  }

  const handleDuplicate = async (profileId: string) => {
    const source = profiles.find(p => p.id === profileId)
    if (!source) return
    await host.profile.duplicate(profileId, `${source.name} (Copy)`)
    loadProfiles()
  }

  const handleTestConnection = useCallback(async (profile: ProfileEntry) => {
    if (!profile.remoteHost || !profile.remoteToken || !profile.remoteFingerprint) return
    setTestingId(profile.id)
    setTestResult(prev => ({ ...prev, [profile.id]: 'testing' }))
    try {
      const dial = await resolveDialEndpoint({
        profileId: profile.sshTarget ? profile.id : undefined,
        remoteHost: profile.remoteHost,
        remotePort: profile.remotePort || 9876,
      })
      const result = await host.remote.testConnection(
        dial.host,
        dial.port,
        profile.remoteToken,
        profile.remoteFingerprint
      )
      setTestResult(prev => ({ ...prev, [profile.id]: result.ok ? 'ok' : 'fail' }))
    } catch {
      setTestResult(prev => ({ ...prev, [profile.id]: 'fail' }))
    } finally {
      setTestingId(null)
    }
  }, [])

  const handleOpenSiblingPicker = async (profile: ProfileEntry) => {
    if (!profile.remoteHost || !profile.remoteToken || !profile.remoteFingerprint) return
    setSiblingSourceId(profile.id)
    setSiblingProfiles([])
    setSiblingError('')
    setSiblingLoading(true)
    try {
      const profiles = await fetchRemoteProfileList(
        profile.remoteHost,
        profile.remotePort || 9876,
        profile.remoteToken,
        profile.remoteFingerprint,
        { profileId: profile.sshTarget ? profile.id : undefined }
      )
      const currentTargetId = profile.remoteProfileId || 'default'
      setSiblingProfiles(profiles.filter(rp => rp.id !== currentTargetId))
    } catch (err) {
      setSiblingError(err instanceof Error ? err.message : String(err))
    } finally {
      setSiblingLoading(false)
    }
  }

  const handleOpenSiblingProfile = async (remoteProfile: RemoteProfileOption) => {
    const source = profiles.find(p => p.id === siblingSourceId)
    if (!source?.remoteHost || !source.remoteToken || !source.remoteFingerprint) return
    const port = source.remotePort || 9876
    const existing = profiles.find(p =>
      p.type === 'remote' &&
      p.remoteHost === source.remoteHost &&
      (p.remotePort || 9876) === port &&
      p.remoteFingerprint === source.remoteFingerprint &&
      (p.remoteProfileId || 'default') === remoteProfile.id
    )

    let targetProfileId = existing?.id
    if (existing) {
      if (existing.remoteToken !== source.remoteToken) {
        await host.profile.update(existing.id, { remoteToken: source.remoteToken })
      }
    } else {
      const entry = await host.profile.create(`${remoteProfile.name} @ ${source.remoteHost}`, {
        type: 'remote',
        remoteHost: source.remoteHost,
        remotePort: port,
        remoteToken: source.remoteToken,
        remoteFingerprint: source.remoteFingerprint,
        remoteProfileId: remoteProfile.id,
        remoteProfileName: remoteProfile.name,
      })
      targetProfileId = entry.id
    }

    setSiblingSourceId(null)
    setSiblingProfiles([])
    setSiblingError('')
    await loadProfiles()
    if (targetProfileId) onSwitchNewWindow(targetProfileId)
  }

  const handleSaveCurrent = async () => {
    if (windowProfileId) {
      await host.profile.save(windowProfileId)
      loadProfiles()
    }
  }

  const handleSwitchRequest = (profileId: string) => {
    if (profileId === windowProfileId) return
    onSwitchNewWindow(profileId)
  }

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleString()
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="settings-header">
          <h2>{t('profiles.title')}</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-body" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button className="profile-action-btn" onClick={handleSaveCurrent} title={t('profiles.saveCurrent')}>
              {t('profiles.saveCurrent')}
            </button>
            <button className="profile-action-btn" onClick={() => { setCreating('local'); setNewName('') }}>
              {t('profiles.addLocal')}
            </button>
            <button className="profile-action-btn" onClick={() => { setCreating('remote'); setNewName('') }}>
              {t('profiles.addRemote')}
            </button>
          </div>

          {creating && (
            <div className="profile-create-row" style={{ flexDirection: 'column', gap: 8 }}>
              <input
                ref={createInputRef}
                type="text"
                className="profile-name-input"
                placeholder={t('profiles.profileNamePlaceholder')}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && creating === 'local') handleCreate()
                  if (e.key === 'Escape') { setCreating(false); setNewName('') }
                }}
              />
              {creating === 'remote' && (
                <>
                  <input
                    type="text"
                    className="profile-name-input"
                    placeholder={t('profiles.connectionUrlPlaceholder', 'Paste connection URL (wss://host:port?token=…&fp=…)')}
                    onChange={e => {
                      const parsed = parseConnectionUrl(e.target.value)
                      if (!parsed) return
                      setRemoteHost(parsed.host)
                      setRemotePort(String(parsed.port))
                      setRemoteToken(parsed.token)
                      setRemoteFingerprint(parsed.fingerprint)
                      setRemoteProfiles([])
                      setSelectedRemoteProfileId('')
                      e.target.value = ''
                    }}
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      className="profile-name-input"
                      placeholder={t('profiles.hostPlaceholder')}
                      value={remoteHost}
                      onChange={e => { setRemoteHost(e.target.value); setRemoteProfiles([]); setSelectedRemoteProfileId('') }}
                      style={{ flex: '1 1 120px' }}
                    />
                    <input
                      type="number"
                      className="profile-name-input"
                      placeholder={t('profiles.portPlaceholder')}
                      value={remotePort}
                      onChange={e => { setRemotePort(e.target.value); setRemoteProfiles([]); setSelectedRemoteProfileId('') }}
                      style={{ width: 70 }}
                    />
                    <input
                      type="text"
                      className="profile-name-input"
                      placeholder={t('profiles.tokenPlaceholder')}
                      value={remoteToken}
                      onChange={e => { setRemoteToken(e.target.value); setRemoteProfiles([]); setSelectedRemoteProfileId('') }}
                      style={{ flex: '1 1 160px' }}
                    />
                  </div>
                  <input
                    type="text"
                    className="profile-name-input"
                    placeholder={t('profiles.fingerprintPlaceholder', 'Cert fingerprint (SHA-256)')}
                    value={remoteFingerprint}
                    onChange={e => { setRemoteFingerprint(e.target.value); setRemoteProfiles([]); setSelectedRemoteProfileId('') }}
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <input
                    type="text"
                    className="profile-name-input"
                    placeholder={t('profiles.sshTargetPlaceholder')}
                    title={t('profiles.sshTargetHint')}
                    value={remoteSshTarget}
                    onChange={e => { setRemoteSshTarget(e.target.value); setRemoteProfiles([]); setSelectedRemoteProfileId('') }}
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      className="profile-action-btn"
                      onClick={handleFetchRemoteProfiles}
                      disabled={fetchingRemoteProfiles || !remoteHost.trim() || !remoteToken.trim() || !remoteFingerprint.trim()}
                    >
                      {fetchingRemoteProfiles ? t('profiles.fetchingProfiles') : t('profiles.fetchProfiles')}
                    </button>
                    {remoteProfileError && (
                      <span style={{ color: '#e5534b', fontSize: 12 }}>{remoteProfileError}</span>
                    )}
                  </div>
                  {remoteProfiles.length > 0 && (
                    <select
                      className="profile-name-input"
                      value={selectedRemoteProfileId}
                      onChange={e => setSelectedRemoteProfileId(e.target.value)}
                      style={{ width: '100%' }}
                    >
                      {remoteProfiles.map(rp => (
                        <option key={rp.id} value={rp.id}>
                          {rp.name} {rp.type === 'remote' ? `(${t('profiles.remote')})` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="profile-action-btn"
                  onClick={handleCreate}
                  disabled={creating === 'remote' && !selectedRemoteProfileId}
                >
                  {t('common.create')}
                </button>
                <button className="profile-action-btn" onClick={() => { setCreating(false); setNewName(''); setRemoteProfiles([]); setSelectedRemoteProfileId('') }}>{t('common.cancel')}</button>
              </div>
            </div>
          )}

          {(() => {
            const localList = profiles.filter(p => p.type !== 'remote')
            const remoteList = profiles.filter(p => p.type === 'remote')
            const isProfileRunning = (p: ProfileEntry) =>
              p.type === 'remote'
                ? !!remoteActiveByLocalId[p.id]
                : activeProfileIds.includes(p.id)
            const renderProfile = (profile: ProfileEntry) => (
              <div
                key={profile.id}
                className={`profile-item ${profile.id === windowProfileId ? 'active' : ''} ${isProfileRunning(profile) ? 'running' : ''}`}
                onClick={() => handleSwitchRequest(profile.id)}
              >
                <div className="profile-item-main">
                <div className="profile-item-info">
                  {editingId === profile.id ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      className="profile-name-input"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onBlur={() => handleRename(profile.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename(profile.id)
                        if (e.key === 'Escape') { setEditingId(null); setEditValue('') }
                      }}
                      onClick={e => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      <span className="profile-item-name">
                        {profile.id === windowProfileId && <span className="profile-active-dot" />}
                        {profile.name}
                        {(profile.type === 'remote') && (
                          <span style={{ fontSize: 10, color: '#58a6ff', marginLeft: 6, opacity: 0.8 }}>{t('profiles.remote')}</span>
                        )}
                      </span>
                      <span className="profile-item-meta">
                        {profile.type === 'remote'
                          ? `${profile.sshTarget ? `ssh ${profile.sshTarget} → ` : ''}${profile.remoteHost}:${profile.remotePort}${profile.remoteProfileId ? ` → ${profile.remoteProfileId}` : ''}`
                          : t('profiles.updated', { date: formatDate(profile.updatedAt) })}
                      </span>
                    </>
                  )}
                </div>
                <div className="profile-item-actions" onClick={e => e.stopPropagation()}>
                  {profile.type === 'remote' && (
                    <button
                      className="profile-icon-btn"
                      title={t('profiles.openRemoteSibling')}
                      onClick={() => handleOpenSiblingPicker(profile)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M5 12h14" />
                        <path d="M12 5l7 7-7 7" />
                      </svg>
                    </button>
                  )}
                  {profile.type === 'remote' && (
                    <button
                      className={`profile-icon-btn ${testResult[profile.id] === 'ok' ? 'success' : testResult[profile.id] === 'fail' ? 'danger' : ''}`}
                      title={testResult[profile.id] === 'ok' ? t('profiles.connected') : testResult[profile.id] === 'fail' ? t('profiles.connectionFailed') : t('profiles.testConnection')}
                      onClick={() => handleTestConnection(profile)}
                      disabled={testingId === profile.id}
                    >
                      {testingId === profile.id ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spin">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                          {testResult[profile.id] === 'ok' && <polyline points="22 4 12 14.01 9 11.01" />}
                          {testResult[profile.id] === 'fail' && <><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>}
                        </svg>
                      )}
                    </button>
                  )}
                  <button
                    className="profile-icon-btn"
                    title={profile.type === 'remote' ? t('profiles.editProfile') : t('profiles.rename')}
                    onClick={() => {
                      if (profile.type === 'remote') {
                        handleStartEditRemote(profile)
                      } else {
                        setEditingId(profile.id)
                        setEditValue(profile.name)
                      }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className="profile-icon-btn"
                    title={t('profiles.duplicate')}
                    onClick={() => handleDuplicate(profile.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  {profile.id !== 'default' && (
                    <button
                      className="profile-icon-btn danger"
                      title={t('common.delete')}
                      onClick={() => setConfirmDelete(profile.id)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                </div>
                </div>
                {/* Remote profile edit form (name + connection) */}
                {editingRemoteId === profile.id && (
                  <div className="profile-remote-edit" onClick={e => e.stopPropagation()}>
                    <input
                      type="text"
                      className="profile-name-input"
                      placeholder={t('profiles.profileNamePlaceholder')}
                      value={editRemoteName}
                      onChange={e => setEditRemoteName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSaveRemote(profile.id) }}
                      style={{ flex: '1 1 100%' }}
                    />
                    <input
                      type="text"
                      className="profile-name-input"
                      placeholder={t('profiles.connectionUrlPlaceholder', 'Paste connection URL (wss://host:port?token=…&fp=…)')}
                      onChange={e => {
                        const parsed = parseConnectionUrl(e.target.value)
                        if (!parsed) return
                        setEditRemoteHost(parsed.host)
                        setEditRemotePort(String(parsed.port))
                        setEditRemoteToken(parsed.token)
                        setEditRemoteFingerprint(parsed.fingerprint)
                        setEditRemoteProfiles([])
                        setEditRemoteProfileError('')
                        e.target.value = ''
                      }}
                      style={{ flex: '1 1 100%', fontFamily: 'monospace', fontSize: 11 }}
                    />
                    <input
                      type="text"
                      className="profile-name-input"
                      placeholder={t('profiles.host')}
                      value={editRemoteHost}
                      onChange={e => { setEditRemoteHost(e.target.value); setEditRemoteProfiles([]); setEditRemoteProfileError('') }}
                      style={{ flex: '1 1 120px' }}
                    />
                    <input
                      type="number"
                      className="profile-name-input"
                      placeholder={t('profiles.portPlaceholder')}
                      value={editRemotePort}
                      onChange={e => { setEditRemotePort(e.target.value); setEditRemoteProfiles([]); setEditRemoteProfileError('') }}
                      style={{ width: 70 }}
                    />
                    <input
                      type="text"
                      className="profile-name-input"
                      placeholder={t('profiles.tokenPlaceholder')}
                      value={editRemoteToken}
                      onChange={e => { setEditRemoteToken(e.target.value); setEditRemoteProfiles([]); setEditRemoteProfileError('') }}
                      style={{ flex: '1 1 160px' }}
                    />
                    <input
                      type="text"
                      className="profile-name-input"
                      placeholder={t('profiles.fingerprintPlaceholder', 'Cert fingerprint (SHA-256)')}
                      value={editRemoteFingerprint}
                      onChange={e => { setEditRemoteFingerprint(e.target.value); setEditRemoteProfiles([]); setEditRemoteProfileError('') }}
                      style={{ flex: '1 1 100%', fontFamily: 'monospace', fontSize: 11 }}
                    />
                    <input
                      type="text"
                      className="profile-name-input"
                      placeholder={t('profiles.sshTargetPlaceholder')}
                      title={t('profiles.sshTargetHint')}
                      value={editRemoteSshTarget}
                      onChange={e => { setEditRemoteSshTarget(e.target.value); setEditRemoteProfiles([]); setEditRemoteProfileError('') }}
                      style={{ flex: '1 1 100%', fontFamily: 'monospace', fontSize: 11 }}
                    />
                    <div style={{ display: 'flex', gap: 6, width: '100%', alignItems: 'center' }}>
                      <button
                        className="profile-action-btn"
                        onClick={handleFetchEditRemoteProfiles}
                        disabled={editFetchingRemoteProfiles || !editRemoteHost.trim() || !editRemoteToken.trim() || !editRemoteFingerprint.trim()}
                      >
                        {editFetchingRemoteProfiles ? t('profiles.fetchingProfiles') : t('profiles.fetchProfiles')}
                      </button>
                      {editRemoteProfileError ? (
                        <span style={{ color: '#e5534b', fontSize: 11 }}>
                          {t('profiles.connectionFailed')}: {editRemoteProfileError}
                        </span>
                      ) : editSelectedRemoteProfileId && editRemoteProfiles.length === 0 && (
                        <span style={{ fontSize: 11, color: '#8b949e' }}>
                          {t('profiles.currentTarget')}: {editSelectedRemoteProfileId}
                        </span>
                      )}
                    </div>
                    {editRemoteProfiles.length > 0 && (
                      <select
                        className="profile-name-input"
                        value={editSelectedRemoteProfileId}
                        onChange={e => setEditSelectedRemoteProfileId(e.target.value)}
                        style={{ width: '100%' }}
                      >
                        {editRemoteProfiles.map(rp => (
                          <option key={rp.id} value={rp.id}>
                            {rp.name} {rp.type === 'remote' ? `(${t('profiles.remote')})` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="profile-action-btn" onClick={() => handleSaveRemote(profile.id)}>{t('common.save')}</button>
                      <button className="profile-action-btn" onClick={() => { setEditingRemoteId(null); setEditRemoteProfiles([]); setEditRemoteProfileError('') }}>{t('common.cancel')}</button>
                    </div>
                  </div>
                )}
              </div>
            )
            return (
              <div className="profile-list">
                <div className="profile-section-header">{t('profiles.localSection')}</div>
                {localList.map(renderProfile)}
                {remoteList.length > 0 && (
                  <>
                    <div className="profile-section-header">{t('profiles.remoteSection')}</div>
                    {remoteList.map(renderProfile)}
                  </>
                )}
              </div>
            )
          })()}
        </div>
      </div>

      {siblingSourceId && (
        <div className="settings-overlay" style={{ zIndex: 1001 }} onClick={() => { setSiblingSourceId(null); setSiblingProfiles([]); setSiblingError('') }}>
          <div className="settings-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 420, padding: 20 }}>
            <h3 style={{ margin: '0 0 12px' }}>{t('profiles.openRemoteSibling')}</h3>
            {siblingLoading && <p style={{ margin: '0 0 12px', color: '#aaa' }}>{t('profiles.fetchingProfiles')}</p>}
            {siblingError && <p style={{ margin: '0 0 12px', color: '#e5534b' }}>{siblingError}</p>}
            {!siblingLoading && !siblingError && siblingProfiles.length === 0 && (
              <p style={{ margin: '0 0 12px', color: '#aaa' }}>{t('profiles.noRemoteProfiles')}</p>
            )}
            {siblingProfiles.length > 0 && (
              <div className="profile-list" style={{ marginBottom: 12 }}>
                {siblingProfiles.map(rp => (
                  <button
                    key={rp.id}
                    className="profile-item"
                    onClick={() => handleOpenSiblingProfile(rp)}
                    style={{ width: '100%', textAlign: 'left', background: 'transparent', color: 'inherit' }}
                  >
                    <span className="profile-item-info">
                      <span className="profile-item-name">{rp.name}</span>
                      <span className="profile-item-meta">{rp.id}{rp.type === 'remote' ? ` · ${t('profiles.remote')}` : ''}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="profile-action-btn" onClick={() => { setSiblingSourceId(null); setSiblingProfiles([]); setSiblingError('') }}>{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <div className="settings-overlay" style={{ zIndex: 1001 }} onClick={() => setConfirmDelete(null)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 360, padding: 20 }}>
            <h3 style={{ margin: '0 0 12px', color: '#e5534b' }}>{t('profiles.deleteProfile')}</h3>
            <p style={{ margin: '0 0 16px', color: '#aaa' }}>
              {t('profiles.deleteConfirm', { name: profiles.find(p => p.id === confirmDelete)?.name })}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="profile-action-btn" onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</button>
              <button className="profile-action-btn danger" onClick={() => handleDelete(confirmDelete)}>{t('common.delete')}</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
