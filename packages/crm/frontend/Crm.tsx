// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { authFetch } from '@/lib/auth';

// Pipeline stages + their tone (mirrors the Charles design: Lead→neutral, Qualified→info,
// Proposal→warn, Won→good, Lost→alert). The tone drives the column dot + the deal-card left border.
const DEFAULT_STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'];
const STAGE_LABEL: Record<string, string> = { lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', won: 'Won', lost: 'Lost' };
const STAGE_TONE: Record<string, string> = { lead: 'faint', qualified: 'info', proposal: 'warn', won: 'good', lost: 'alert' };

interface Deal { id: string; name: string; stage: string; value_cents: number; currency: string; contact_name?: string; company?: string }
interface Contact { id: string; name: string; email?: string; company?: string; role?: string }
interface Activity { id: string; kind: string; body?: string; deal_id?: string; contact_id?: string; occurred_at: string }
interface PipelineColumn { stage: string; deals: Deal[]; total_cents: number; count: number }
type View = 'pipeline' | 'contacts';

export default function Crm() {
  const params = useSearchParams();
  const [view, setView] = useState<View>('pipeline');
  const [columns, setColumns] = useState<PipelineColumn[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedDeal, setSelectedDeal] = useState<string | null>(null);
  const [dealActivities, setDealActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [ventures, setVentures] = useState<Array<{ id: string; name: string }>>([]);
  const [ventureId, setVentureId] = useState(params.get('venture_id') || '');

  // The CRM is venture-scoped. Load the user's ventures and default to the first — without this the
  // page hangs on "Loading…" when there's no ?venture_id in the URL.
  useEffect(() => {
    void (async () => {
      try {
        const r = await authFetch('/api/content/ventures');
        const j = (await r.json()) as { ventures?: Array<{ id: string; name: string }> };
        const vs = (j.ventures || []).map((v) => ({ id: v.id, name: v.name }));
        setVentures(vs);
        setVentureId((cur) => cur || vs[0]?.id || '');
        if (!vs.length) setLoading(false);
      } catch { setLoading(false); }
    })();
  }, []);

  useEffect(() => {
    if (!ventureId) return;
    void loadPipeline();
    if (view === 'contacts') void loadContacts();
  }, [ventureId, view]);

  async function loadPipeline() {
    try {
      const res = await authFetch(`/api/crm/pipeline?venture_id=${ventureId}`);
      const data = (await res.json()) as { columns?: PipelineColumn[] };
      setColumns(data.columns || []);
    } catch (e) { console.error('pipeline', e); } finally { setLoading(false); }
  }
  async function loadContacts() {
    try {
      const res = await authFetch(`/api/crm/contacts?venture_id=${ventureId}`);
      const data = (await res.json()) as { contacts?: Contact[] };
      setContacts(data.contacts || []);
    } catch (e) { console.error('contacts', e); }
  }
  async function loadDealActivities(dealId: string) {
    try {
      const res = await authFetch(`/api/crm/activities?deal_id=${dealId}&venture_id=${ventureId}`);
      const data = (await res.json()) as { activities?: Activity[] };
      setDealActivities(data.activities || []);
    } catch (e) { console.error('activities', e); }
  }
  async function moveDeal(dealId: string, newStage: string) {
    try {
      const targetCol = columns.find((c) => c.stage === newStage);
      const res = await authFetch(`/api/crm/deals`, {
        method: 'PUT',
        body: JSON.stringify({ deal_id: dealId, stage: newStage, position: targetCol?.count || 0, venture_id: ventureId }),
      });
      if (res.ok) await loadPipeline();
    } catch (e) { console.error('move', e); }
  }

  const money = (cents: number, currency = 'GBP') =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
  const relTime = (s: string) => {
    const d = Date.now() - new Date(s).getTime(), m = Math.floor(d / 60000), h = Math.floor(d / 3600000), dd = Math.floor(d / 86400000);
    if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; if (h < 24) return `${h}h ago`;
    if (dd < 7) return `${dd}d ago`; return new Date(s).toLocaleDateString();
  };

  const columnMap = new Map(columns.map((c) => [c.stage, c]));
  const selDeal = selectedDeal ? columns.flatMap((c) => c.deals).find((d) => d.id === selectedDeal) : null;
  const openCount = columns.filter((c) => c.stage !== 'won' && c.stage !== 'lost').reduce((a, c) => a + c.count, 0);

  if (loading) return <div className="crm-screen"><div className="screen-sub" style={{ padding: 'var(--s5)' }}>Loading…</div></div>;

  return (
    <div className="crm-screen">
      <div className="crm-body">
        <div className="crm-main">
          <div className="screen-head">
            <div>
              <h1 className="screen-title">CRM</h1>
              <p className="screen-sub">{ventures.find((v) => v.id === ventureId)?.name || 'Venture'} · {openCount} open deal{openCount === 1 ? '' : 's'}</p>
            </div>
            <div className="row" style={{ gap: 'var(--s2)' }}>
              {ventures.length > 0 && (
                <select className="crm-vsel" value={ventureId} onChange={(e) => { setVentureId(e.target.value); setSelectedDeal(null); }} aria-label="Venture">
                  {ventures.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              )}
              <div className="seg">
                {(['pipeline', 'contacts'] as View[]).map((v) => (
                  <button key={v} className="seg__opt" aria-selected={view === v} onClick={() => setView(v)}>{v === 'pipeline' ? 'Pipeline' : 'Contacts'}</button>
                ))}
              </div>
            </div>
          </div>

          {view === 'pipeline' ? (
            columns.every((c) => c.count === 0) ? (
              <div className="empty"><div className="empty__title">No deals yet</div><div className="empty__body">Add a deal to start tracking your pipeline.</div></div>
            ) : (
              <div className="kanban">
                {DEFAULT_STAGES.map((stage) => {
                  const col = columnMap.get(stage);
                  const tone = STAGE_TONE[stage];
                  return (
                    <div className="kancol" key={stage}>
                      <div className="kancol__head">
                        <span className="kancol__name"><span className="tonedot" style={{ background: `var(--${tone})` }} />{STAGE_LABEL[stage]}</span>
                        <span className="num kancol__sum">{money(col?.total_cents || 0)}</span>
                      </div>
                      {(col?.deals || []).map((d) => (
                        <button key={d.id} className={'dealcard' + (selectedDeal === d.id ? ' is-sel' : '')} style={{ borderLeft: `3px solid var(--${tone === 'faint' ? 'border-strong' : tone})` }}
                          onClick={() => { setSelectedDeal(d.id); void loadDealActivities(d.id); }}>
                          <div className="dealcard__name">{d.name}</div>
                          <div className="dealcard__meta">
                            <span className="num">{money(d.value_cents, d.currency)}</span>
                            {d.contact_name && <span className="screen-sub" style={{ margin: 0 }}>· {d.contact_name}</span>}
                          </div>
                          {stage !== 'won' && stage !== 'lost' && (
                            <span className="dealcard__move" role="button" tabIndex={0} title="Move to next stage"
                              onClick={(e) => { e.stopPropagation(); const i = DEFAULT_STAGES.indexOf(stage); if (i + 1 < DEFAULT_STAGES.length) void moveDeal(d.id, DEFAULT_STAGES[i + 1]); }}>→</span>
                          )}
                        </button>
                      ))}
                      <button className="kancol__add">+ Add</button>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            contacts.length === 0 ? (
              <div className="empty"><div className="empty__title">No contacts yet</div><div className="empty__body">Add a contact or import them to start.</div></div>
            ) : (
              <div className="card" style={{ paddingTop: 8, paddingBottom: 8 }}>
                <div className="loglist">
                  {contacts.map((c) => (
                    <button key={c.id} className="logrow contact-row" onClick={() => setSelectedDeal(null)}>
                      <span className="contact-av">{c.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>
                      <span className="logrow__main">
                        <span className="logrow__primary">{c.name}</span>
                        <span className="logrow__meta">{[c.company, c.role, c.email].filter(Boolean).join(' · ')}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )
          )}
        </div>

        {selDeal && (
          <aside className="ctxpanel">
            <div className="ctxpanel__tag">{selDeal.name} · activity</div>
            <div className="card" style={{ marginBottom: 'var(--s4)' }}>
              <div className="stat"><span className="stat__label">Deal value</span><span className="stat__value num" style={{ fontSize: 'var(--fs-24)' }}>{money(selDeal.value_cents, selDeal.currency)}</span></div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className={'pill pill--' + STAGE_TONE[selDeal.stage]}><span className="pill__dot" />{STAGE_LABEL[selDeal.stage]}</span>
              </div>
            </div>
            <div className="timeline">
              {dealActivities.length === 0 ? <p className="screen-sub">No activity yet.</p> : dealActivities.map((a) => {
                const title = a.kind === 'stage_change' && a.body ? a.body : a.kind;
                return (
                  <div className="timeline__row" key={a.id}>
                    <span className="timeline__dot" style={{ background: 'var(--info)' }} />
                    <span className="timeline__main"><span className="timeline__title">{title}</span><span className="timeline__meta">{relTime(a.occurred_at)}</span></span>
                  </div>
                );
              })}
            </div>
            <button className="btn btn--ghost" style={{ marginTop: 'var(--s3)', width: '100%', justifyContent: 'center' }} onClick={() => setSelectedDeal(null)}>Close</button>
          </aside>
        )}
      </div>
    </div>
  );
}
