import { FormEvent, useEffect, useState } from 'react';
import { AccountInfo } from '@azure/msal-browser';
import { extractErrorCode } from '../api/client';
import { AzureSignInRequired, azureAccount, azureErrorText, LiveAzureConfig, liveAzureConfig, signInToAzure, signOutOfAzure } from '../api/azureAuth';
import { azureBuilderApi, LiveConnectionInput, LiveSubscription, REGIONS } from '../api/azureBuilder';

const NEW_GROUP = '__new__';

/** True when the error means the Azure sign-in is missing or no longer valid. */
function needsSignIn(err: unknown) {
  return err instanceof AzureSignInRequired || extractErrorCode(err) === 'AZURE_SIGN_IN_REQUIRED';
}

/**
 * Phase 0, live (Wave 6): sign in to Azure, pick a subscription, resource group and region the
 * signed-in user can see, and let Azure confirm the permission level. Hidden when the server has
 * no Entra app registration configured - the offline form below still works.
 */
export function AzureLiveConnect({ projectId, onConnected }: { projectId: string; onConnected: () => Promise<void> }) {
  const [config, setConfig] = useState<LiveAzureConfig | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [subscriptions, setSubscriptions] = useState<LiveSubscription[] | null>(null);
  const [groups, setGroups] = useState<Array<{ name: string; location: string }> | null>(null);
  const [form, setForm] = useState<LiveConnectionInput>({ subscriptionId: '', resourceGroup: '', resourceGroupMode: 'existing', region: 'centralindia', deploymentModel: 'hub_and_spoke' });
  const [groupChoice, setGroupChoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fail = (err: unknown, fallback: string) => {
    if (needsSignIn(err)) setAccount(null);
    setError(err instanceof AzureSignInRequired ? err.message : azureErrorText(err, fallback));
  };

  const loadSubscriptions = async () => {
    setBusy('Reading your subscriptions...');
    try {
      const subs = await azureBuilderApi.liveSubscriptions(projectId);
      setSubscriptions(subs);
      if (subs.length === 1) await pickSubscription(subs[0].subscriptionId);
    } catch (err) {
      fail(err, 'Could not list your Azure subscriptions.');
    } finally {
      setBusy(null);
    }
  };

  const pickSubscription = async (subscriptionId: string) => {
    setForm((f) => ({ ...f, subscriptionId, resourceGroup: '' }));
    setGroupChoice('');
    setGroups(null);
    if (!subscriptionId) return;
    try {
      setGroups(await azureBuilderApi.liveResourceGroups(projectId, subscriptionId));
    } catch (err) {
      fail(err, 'Could not list the resource groups.');
    }
  };

  const pickGroup = (choice: string) => {
    setGroupChoice(choice);
    if (choice === NEW_GROUP) {
      setForm((f) => ({ ...f, resourceGroup: '', resourceGroupMode: 'new' }));
    } else {
      const g = groups?.find((x) => x.name === choice);
      setForm((f) => ({ ...f, resourceGroup: choice, resourceGroupMode: 'existing', region: g?.location ?? f.region }));
    }
  };

  useEffect(() => {
    (async () => {
      const c = await liveAzureConfig();
      setConfig(c);
      if (!c.enabled) return;
      const a = await azureAccount();
      setAccount(a);
      if (a) await loadSubscriptions();
    })().catch((err) => fail(err, 'Could not start the Azure sign-in.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy('Verifying the target with Azure...');
    try {
      await azureBuilderApi.connectLive(projectId, form);
      await onConnected();
    } catch (err) {
      fail(err, 'Could not connect.');
    } finally {
      setBusy(null);
    }
  };

  if (!config?.enabled) return null;

  return (
    <form className="card" style={{ marginBottom: 16 }} onSubmit={onSubmit} aria-label="Live Azure connection">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="metric-label" style={{ margin: 0 }}>Connect with your Azure sign-in (live)</div>
        {account && <span className="status-pill validated">Signed in as {account.username}</span>}
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
        You sign in to Microsoft directly; Evectorize gets a short-lived token to read Azure as you, for the request that needs it. It is
        never stored. Azure, not this form, says what you are allowed to do on the target.
      </p>

      {!account ? (
        <button type="button" className="primary-btn" onClick={() => signInToAzure().catch((err) => fail(err, 'Could not start the Azure sign-in.'))}>
          Sign in to Azure
        </button>
      ) : (
        <>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="liveSubscription">Subscription</label>
              <select id="liveSubscription" value={form.subscriptionId} onChange={(e) => pickSubscription(e.target.value)} required>
                <option value="">{subscriptions ? (subscriptions.length ? 'Choose a subscription' : 'No subscriptions visible to you') : 'Loading...'}</option>
                {subscriptions?.map((s) => <option key={s.subscriptionId} value={s.subscriptionId} disabled={s.state !== 'Enabled'}>{s.displayName} ({s.subscriptionId}){s.state !== 'Enabled' ? ` - ${s.state}` : ''}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="liveGroup">Resource group</label>
              <select id="liveGroup" value={groupChoice} onChange={(e) => pickGroup(e.target.value)} required disabled={!groups}>
                <option value="">{groups ? 'Choose a resource group' : form.subscriptionId ? 'Loading...' : 'Choose a subscription first'}</option>
                {groups?.map((g) => <option key={g.name} value={g.name}>{g.name} ({g.location})</option>)}
                <option value={NEW_GROUP}>New resource group...</option>
              </select>
            </div>
            {groupChoice === NEW_GROUP && (
              <div className="field">
                <label htmlFor="liveNewGroup">New resource group name</label>
                <input id="liveNewGroup" value={form.resourceGroup} onChange={(e) => setForm({ ...form, resourceGroup: e.target.value.trim() })} placeholder="rg-uc-hr-assistant-dev-cin" required />
              </div>
            )}
            <div className="field">
              <label htmlFor="liveRegion">Region</label>
              <select id="liveRegion" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })}>
                {!REGIONS.some((r) => r.value === form.region) && <option value={form.region}>{form.region}</option>}
                {REGIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="liveModel">Deployment model</label>
              <select id="liveModel" value={form.deploymentModel} onChange={(e) => setForm({ ...form, deploymentModel: e.target.value as LiveConnectionInput['deploymentModel'] })}>
                <option value="hub_and_spoke">Hub-and-spoke (default)</option>
                <option value="centralised">Centralised</option>
                <option value="federated">Federated</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="primary-btn" type="submit" disabled={!!busy || !form.subscriptionId || !form.resourceGroup}>Verify and connect</button>
            <button type="button" className="primary-btn" style={{ background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)' }}
              onClick={() => signOutOfAzure().then(() => { setAccount(null); setSubscriptions(null); setGroups(null); })}>
              Sign out of Azure
            </button>
          </div>
        </>
      )}
      {busy && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>{busy}</div>}
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
    </form>
  );
}
