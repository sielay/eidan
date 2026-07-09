// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { authFetch } from '@/lib/auth';

// Default pipeline stages. These can be configured per-venture via backend API in future versions.
const DEFAULT_STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'];

interface Deal {
  id: string;
  name: string;
  stage: string;
  value_cents: number;
  currency: string;
  contact_name?: string;
  company?: string;
}

interface Contact {
  id: string;
  name: string;
  email?: string;
  company?: string;
  role?: string;
}

interface Activity {
  id: string;
  kind: string;
  body?: string;
  deal_id?: string;
  contact_id?: string;
  occurred_at: string;
}

interface PipelineColumn {
  stage: string;
  deals: Deal[];
  total_cents: number;
  count: number;
}

type View = 'pipeline' | 'contacts';

export default function Crm() {
  const params = useSearchParams();

  const [view, setView] = useState<View>('pipeline');
  const [columns, setColumns] = useState<PipelineColumn[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedDeal, setSelectedDeal] = useState<string | null>(null);
  const [dealActivities, setDealActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddStage, setQuickAddStage] = useState<string | null>(null);

  const ventureId = params.get('venture_id') || '';

  useEffect(() => {
    if (!ventureId) return;
    loadPipeline();
    if (view === 'contacts') loadContacts();
  }, [ventureId, view]);

  useEffect(() => {
    if (view === 'contacts') {
      setSelectedDeal(null);
    }
  }, [view]);

  async function loadPipeline() {
    if (!ventureId) return;
    try {
      const res = await authFetch(`/api/crm/pipeline?venture_id=${ventureId}`);
      const data = (await res.json()) as { columns?: PipelineColumn[] };
      setColumns(data.columns || []);
      setLoading(false);
    } catch (e) {
      console.error('Failed to load pipeline:', e);
      setLoading(false);
    }
  }

  async function loadContacts() {
    if (!ventureId) return;
    try {
      const res = await authFetch(`/api/crm/contacts?venture_id=${ventureId}`);
      const data = (await res.json()) as { contacts?: Contact[] };
      setContacts(data.contacts || []);
    } catch (e) {
      console.error('Failed to load contacts:', e);
    }
  }

  async function loadDealActivities(dealId: string) {
    try {
      const res = await authFetch(`/api/crm/activities?deal_id=${dealId}&venture_id=${ventureId}`);
      const data = (await res.json()) as { activities?: Activity[] };
      setDealActivities(data.activities || []);
    } catch (e) {
      console.error('Failed to load activities:', e);
    }
  }

  async function moveDeal(dealId: string, newStage: string) {
    try {
      const res = await authFetch(`/api/crm/deals`, {
        method: 'PUT',
        body: JSON.stringify({ deal_id: dealId, stage: newStage, venture_id: ventureId }),
      });
      if (res.ok) {
        // Update local state instead of reloading entire pipeline for better performance
        setColumns((prevColumns) => {
          const dealToMove = prevColumns.flatMap((c) => c.deals).find((d) => d.id === dealId);
          if (!dealToMove) return prevColumns;

          // Remove deal from all columns and adjust their totals
          const updated = prevColumns.map((col) => {
            const dealToRemove = col.deals.find((d) => d.id === dealId);
            return {
              ...col,
              deals: col.deals.filter((d) => d.id !== dealId),
              total_cents: col.total_cents - (dealToRemove?.value_cents || 0),
              count: col.count - (dealToRemove ? 1 : 0),
            };
          });

          // Add deal to the new column, or create it in the correct order if it doesn't exist
          const newColIdx = updated.findIndex((c) => c.stage === newStage);
          if (newColIdx >= 0) {
            updated[newColIdx].deals.push(dealToMove);
            updated[newColIdx].total_cents += dealToMove.value_cents;
            updated[newColIdx].count += 1;
          } else {
            // Insert new column at the correct position according to DEFAULT_STAGES
            const stagePosition = DEFAULT_STAGES.indexOf(newStage);
            const insertIdx = updated.findIndex((c) => DEFAULT_STAGES.indexOf(c.stage) > stagePosition);
            const newCol: PipelineColumn = {
              stage: newStage,
              deals: [dealToMove],
              total_cents: dealToMove.value_cents,
              count: 1,
            };
            if (insertIdx >= 0) {
              updated.splice(insertIdx, 0, newCol);
            } else {
              updated.push(newCol);
            }
          }

          return updated;
        });
      }
    } catch (e) {
      console.error('Failed to move deal:', e);
    }
  }

  function getColumnSum(col: PipelineColumn | undefined): { total: number; currency: string } {
    if (!col || col.count === 0) return { total: 0, currency: 'GBP' };
    // Infer currency from first deal in column. Assumes all deals within a stage have the same currency;
    // if mixed currencies exist, the sum may be misleading and should be broken down by currency.
    const firstDeal = col.deals[0];
    return { total: col.total_cents, currency: firstDeal?.currency || 'GBP' };
  }

  function formatCurrency(cents: number, currency: string): string {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  }

  function formatTime(dateStr: string) {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    if (diff < 0) return 'in the future';
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min${mins !== 1 ? 's' : ''} ago`;
    if (hours < 24) return `${hours} hr${hours !== 1 ? 's' : ''} ago`;
    if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
    return date.toLocaleDateString('en-GB');
  }

  function formatColumnSum(col: PipelineColumn | undefined): string {
    const { total, currency } = getColumnSum(col);
    return formatCurrency(total, currency);
  }

  // Build a Map for O(1) lookup of columns by stage
  const columnMap = useMemo(() => new Map(columns.map((c) => [c.stage, c])), [columns]);

  if (loading) return <div className="screen-head">Loading...</div>;

  return (
    <div className="crm-shell">
      <div className="screen-head">
        <h1 className="screen-title">CRM</h1>
        <div className="crm-nav">
          <button
            className={`crm-nav-item ${view === 'pipeline' ? 'is-active' : ''}`}
            onClick={() => setView('pipeline')}
          >
            Pipeline
          </button>
          <button
            className={`crm-nav-item ${view === 'contacts' ? 'is-active' : ''}`}
            onClick={() => setView('contacts')}
          >
            Contacts
          </button>
        </div>
      </div>

      {view === 'pipeline' && (
        <div className="crm-pipeline">
          <div className="kanban">
            {DEFAULT_STAGES.map((stage) => {
              const col = columnMap.get(stage);
              return (
                <div key={stage} className="kancol">
                  <div className="kancol__head">
                    <div className="kancol__name">{stage}</div>
                    <div className="kancol__sum">
                      {formatColumnSum(col)} ({col?.count || 0})
                    </div>
                  </div>
                  <div className="kancol__deals">
                    {col?.deals.map((deal) => (
                      <div
                        key={deal.id}
                        className={`dealcard ${selectedDeal === deal.id ? 'is-sel' : ''}`}
                        onClick={() => {
                          setSelectedDeal(deal.id);
                          loadDealActivities(deal.id);
                        }}
                      >
                        <div className="dealcard__name">{deal.name}</div>
                        <div className="dealcard__meta">
                          {deal.contact_name && <span>{deal.contact_name}</span>}
                          {deal.contact_name && deal.company && <span>, </span>}
                          {deal.company && <span>{deal.company}</span>}
                          <span className="--font-num">{formatCurrency(deal.value_cents, deal.currency)}</span>
                        </div>
                        {stage !== 'won' && stage !== 'lost' && (
                          <div className="dealcard__actions">
                            {DEFAULT_STAGES.indexOf(stage) > 0 && (
                              <button
                                className="dealcard__arrow"
                                aria-label="Move deal to previous stage"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const stageIdx = DEFAULT_STAGES.indexOf(stage);
                                  if (stageIdx > 0) {
                                    moveDeal(deal.id, DEFAULT_STAGES[stageIdx - 1]);
                                  }
                                }}
                              >
                                ←
                              </button>
                            )}
                            {DEFAULT_STAGES.indexOf(stage) < DEFAULT_STAGES.length - 1 && (
                              <button
                                className="dealcard__arrow"
                                aria-label="Move deal to next stage"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const stageIdx = DEFAULT_STAGES.indexOf(stage);
                                  if (stageIdx + 1 < DEFAULT_STAGES.length) {
                                    moveDeal(deal.id, DEFAULT_STAGES[stageIdx + 1]);
                                  }
                                }}
                              >
                                →
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    className="kancol__add"
                    aria-label={`Add deal to ${stage} stage`}
                    onClick={() => {
                      setQuickAddStage(stage);
                      setShowQuickAdd(true);
                    }}
                  >
                    + Add deal
                  </button>
                </div>
              );
            })}
          </div>

          {selectedDeal && (
            <div className="ctxpanel">
              <div className="ctxpanel__head">
                <h3>Activity</h3>
                <button aria-label="Close activity panel" onClick={() => setSelectedDeal(null)}>
                  ×
                </button>
              </div>
              <div className="timeline">
                {dealActivities.length === 0 ? (
                  <p className="ctxpanel__empty">No activities yet</p>
                ) : (
                  dealActivities.map((activity) => {
                    const title = activity.body || activity.kind.charAt(0).toUpperCase() + activity.kind.slice(1);
                    return (
                      <div key={activity.id} className="timeline__row">
                        <div className="timeline__dot"></div>
                        <div>
                          <div className="timeline__title">{title}</div>
                          <div className="timeline__meta">{formatTime(activity.occurred_at)}</div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {view === 'contacts' && (
        <div className="crm-contacts">
          {contacts.length === 0 ? (
            <div className="screen-sub">No contacts yet</div>
          ) : (
            <div className="contact-list">
              {contacts.map((contact) => (
                <div key={contact.id} className="contact-row">
                  <div className="contact-av">{contact.name.charAt(0).toUpperCase()}</div>
                  <div className="contact-info">
                    <div className="contact-name">{contact.name}</div>
                    <div className="contact-meta">
                      {contact.company && <span>{contact.company}</span>}
                      {contact.company && contact.role && <span>, </span>}
                      {contact.role && <span>{contact.role}</span>}
                      {(contact.company || contact.role) && contact.email && <span>, </span>}
                      {contact.email && <span>{contact.email}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .crm-shell {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
        }

        .screen-head {
          display: flex;
          flex-direction: column;
          gap: var(--s2);
          padding: var(--s3);
          border-bottom: 1px solid var(--border);
          background: var(--surface);
        }

        .screen-title {
          font-size: var(--fs-20);
          font-weight: 500;
          margin: 0;
        }

        .crm-nav {
          display: flex;
          gap: var(--s1);
        }

        .crm-nav-item {
          padding: var(--s2) 0;
          border: none;
          background: none;
          cursor: pointer;
          color: var(--text-secondary);
          border-bottom: 2px solid transparent;
          font-size: var(--fs-15);
          transition: all 0.2s;
        }

        .crm-nav-item:hover {
          color: var(--text);
        }

        .crm-nav-item.is-active {
          color: var(--accent);
          border-bottom-color: var(--accent);
        }

        .crm-pipeline {
          display: flex;
          flex: 1;
          overflow: hidden;
          gap: var(--s2);
          padding: var(--s3);
        }

        .kanban {
          display: flex;
          gap: var(--s2);
          overflow-x: auto;
          flex: 1;
        }

        @media (max-width: 768px) {
          .kanban {
            scroll-snap-type: x mandatory;
          }
        }

        .kancol {
          flex: 0 0 300px;
          display: flex;
          flex-direction: column;
          background: var(--surface-2);
          border-radius: var(--r-md);
          border: 1px solid var(--border);
          overflow: hidden;
        }

        @media (max-width: 768px) {
          .kancol {
            flex: 0 0 80%;
            scroll-snap-align: start;
          }
        }

        .kancol__head {
          padding: var(--s2);
          border-bottom: 1px solid var(--border);
        }

        .kancol__name {
          font-size: var(--fs-15);
          font-weight: 500;
          text-transform: capitalize;
        }

        .kancol__sum {
          font-size: var(--fs-13);
          color: var(--text-secondary);
          margin-top: var(--s1);
          font-variant-numeric: tabular-nums;
        }

        .kancol__deals {
          flex: 1;
          overflow-y: auto;
          padding: var(--s2);
          display: flex;
          flex-direction: column;
          gap: var(--s2);
        }

        .dealcard {
          padding: var(--s2);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--r-sm);
          cursor: pointer;
          transition: all 0.2s;
        }

        .dealcard:hover {
          border-color: var(--accent);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .dealcard.is-sel {
          border-color: var(--accent);
          background: var(--accent-soft);
        }

        .dealcard__name {
          font-size: var(--fs-15);
          font-weight: 500;
          margin-bottom: var(--s1);
          word-break: break-word;
        }

        .dealcard__meta {
          font-size: var(--fs-13);
          color: var(--text-secondary);
          display: flex;
          gap: var(--s0);
        }

        .dealcard__actions {
          display: flex;
          gap: var(--s1);
          margin-top: var(--s1);
        }

        .dealcard__arrow {
          background: none;
          border: none;
          color: var(--accent);
          cursor: pointer;
          font-size: var(--fs-17);
          padding: 0;
          opacity: 0.6;
          transition: opacity 0.2s;
        }

        .dealcard__arrow:hover {
          opacity: 1;
        }

        .kancol__add {
          margin: var(--s2);
          padding: var(--s2);
          background: var(--surface);
          border: 1px dashed var(--border-strong);
          border-radius: var(--r-sm);
          color: var(--text-secondary);
          cursor: pointer;
          font-size: var(--fs-13);
          transition: all 0.2s;
        }

        .kancol__add:hover {
          border-color: var(--accent);
          color: var(--accent);
        }

        .ctxpanel {
          flex: 0 0 320px;
          display: flex;
          flex-direction: column;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--r-md);
          overflow: hidden;
          min-width: 280px;
          max-width: 400px;
        }

        @media (max-width: 1024px) {
          .ctxpanel {
            flex: 0 0 280px;
          }
        }

        .ctxpanel__head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--s2);
          border-bottom: 1px solid var(--border);
        }

        .ctxpanel__head h3 {
          margin: 0;
          font-size: var(--fs-15);
        }

        .ctxpanel__head button {
          background: none;
          border: none;
          cursor: pointer;
          font-size: var(--fs-17);
          color: var(--text-secondary);
        }

        .ctxpanel__empty {
          padding: var(--s3);
          color: var(--text-secondary);
          text-align: center;
          margin: 0;
        }

        .timeline {
          flex: 1;
          overflow-y: auto;
          padding: var(--s2);
          display: flex;
          flex-direction: column;
          gap: var(--s2);
        }

        .timeline__row {
          display: flex;
          gap: var(--s2);
          align-items: flex-start;
        }

        .timeline__dot {
          flex: 0 0 8px;
          width: 8px;
          height: 8px;
          border-radius: var(--r-full);
          background: var(--accent);
          margin-top: 6px;
        }

        .timeline__title {
          font-size: var(--fs-13);
          font-weight: 500;
        }

        .timeline__meta {
          font-size: var(--fs-13);
          color: var(--text-secondary);
          margin-top: var(--s0);
        }

        .crm-contacts {
          flex: 1;
          overflow-y: auto;
          padding: var(--s3);
        }

        .contact-list {
          display: flex;
          flex-direction: column;
          gap: var(--s2);
        }

        .contact-row {
          display: flex;
          gap: var(--s2);
          padding: var(--s2);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--r-sm);
          cursor: pointer;
          transition: all 0.2s;
        }

        .contact-row:hover {
          border-color: var(--accent);
        }

        .contact-av {
          flex: 0 0 40px;
          width: 40px;
          height: 40px;
          border-radius: var(--r-full);
          background: var(--accent);
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 500;
        }

        .contact-info {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: var(--s0);
        }

        .contact-name {
          font-size: var(--fs-15);
          font-weight: 500;
        }

        .contact-meta {
          font-size: var(--fs-13);
          color: var(--text-secondary);
          display: flex;
          gap: var(--s1);
          flex-wrap: wrap;
        }

        .screen-sub {
          text-align: center;
          color: var(--text-secondary);
          padding: var(--s4);
        }
      `}</style>
    </div>
  );
}
