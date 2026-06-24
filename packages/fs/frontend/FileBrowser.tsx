// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { authFetch } from "@/lib/auth";

interface FsNode {
  id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  storage_kind: string;
  mime: string | null;
  size_bytes: number | null;
  storage_ref: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface BreadcrumbItem {
  id: string | null;
  name: string;
}

export default function FileBrowser(): React.ReactElement {
  const [nodes, setNodes] = React.useState<FsNode[]>([]);
  const [currentParentId, setCurrentParentId] = React.useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = React.useState<BreadcrumbItem[]>([{ id: null, name: "Files" }]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [showNewFolder, setShowNewFolder] = React.useState(false);
  const [newFolderName, setNewFolderName] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState("");

  const loadFolder = React.useCallback(
    async (parentId: string | null) => {
      setLoading(true);
      setError("");
      try {
        const url = new URL("/api/fs", window.location.origin);
        if (parentId) url.searchParams.set("parent", parentId);
        const res = await authFetch(url.toString());
        if (res.ok) {
          const data = (await res.json()) as { nodes: FsNode[] };
          setNodes(data.nodes);
          setCurrentParentId(parentId);
        } else {
          setError("Failed to load folder");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    void loadFolder(null);
  }, [loadFolder]);

  const handleNavigateFolder = (nodeId: string, nodeName: string) => {
    setBreadcrumbs([...breadcrumbs, { id: nodeId, name: nodeName }]);
    void loadFolder(nodeId);
  };

  const handleBreadcrumbClick = (index: number) => {
    const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
    setBreadcrumbs(newBreadcrumbs);
    void loadFolder(newBreadcrumbs[index]!.id);
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    try {
      const res = await authFetch("/api/fs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "mkdir",
          name: newFolderName,
          parent_id: currentParentId,
        }),
      });
      if (res.ok) {
        setNewFolderName("");
        setShowNewFolder(false);
        await loadFolder(currentParentId);
      } else {
        setError("Failed to create folder");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleRename = async (nodeId: string) => {
    if (!editingName.trim()) return;
    try {
      const res = await authFetch("/api/fs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "rename",
          id: nodeId,
          name: editingName,
        }),
      });
      if (res.ok) {
        setEditingId(null);
        setEditingName("");
        await loadFolder(currentParentId);
      } else {
        setError("Failed to rename");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleDelete = async (nodeId: string) => {
    if (!confirm("Are you sure you want to delete this?")) return;
    try {
      const res = await authFetch(`/api/fs?id=${encodeURIComponent(nodeId)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        await loadFolder(currentParentId);
      } else {
        setError("Failed to delete");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleDownload = async (nodeId: string, nodeName: string) => {
    try {
      const res = await authFetch(`/api/fs/file?id=${encodeURIComponent(nodeId)}`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = nodeName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        setError("Failed to download");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.currentTarget.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      const formData = new FormData();
      formData.append("file", file);
      if (currentParentId) formData.append("parent_id", currentParentId);
      try {
        const res = await authFetch("/api/fs/file", {
          method: "POST",
          body: formData,
        });
        if (res.ok) {
          await loadFolder(currentParentId);
        } else {
          setError("Failed to upload file");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    }
    e.currentTarget.value = "";
  };

  return (
    <div className="min-h-screen p-6" style={{ backgroundColor: "var(--bg)" }}>
      <div className="max-w-4xl mx-auto">
        <h1 style={{ fontSize: "var(--fs-32)", fontWeight: 600, marginBottom: "var(--s4)" }}>Files</h1>

        {/* Breadcrumb */}
        <div style={{ marginBottom: "var(--s4)", display: "flex", gap: "var(--s2)", alignItems: "center", fontSize: "var(--fs-15)" }}>
          {breadcrumbs.map((item, index) => (
            <React.Fragment key={index}>
              {index > 0 && <span style={{ color: "var(--muted)" }}>/</span>}
              {index === breadcrumbs.length - 1 ? (
                <span style={{ fontWeight: 500 }}>{item.name}</span>
              ) : (
                <button
                  onClick={() => handleBreadcrumbClick(index)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--accent)",
                    cursor: "pointer",
                    fontSize: "inherit",
                    padding: 0,
                  }}
                >
                  {item.name}
                </button>
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Controls */}
        <div style={{ display: "flex", gap: "var(--s3)", marginBottom: "var(--s4)", flexWrap: "wrap" }}>
          <button
            onClick={() => setShowNewFolder(!showNewFolder)}
            style={{
              padding: "var(--s2) var(--s3)",
              backgroundColor: "var(--accent)",
              color: "var(--accent-contrast)",
              border: "none",
              borderRadius: "var(--r-sm)",
              cursor: "pointer",
              fontSize: "var(--fs-15)",
              fontWeight: 500,
            }}
          >
            New Folder
          </button>
          <label
            className="btn btn--ghost"
            style={{ cursor: "pointer", display: "inline-flex", alignItems: "center" }}
          >
            Upload
            <input
              type="file"
              multiple
              onChange={handleUpload}
              style={{ display: "none" }}
              accept="*/*"
            />
          </label>
        </div>

        {/* New Folder Form */}
        {showNewFolder && (
          <form
            onSubmit={handleCreateFolder}
            style={{
              padding: "var(--s3)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-md)",
              backgroundColor: "var(--surface)",
              marginBottom: "var(--s4)",
            }}
          >
            <div style={{ marginBottom: "var(--s3)" }}>
              <label style={{ display: "block", marginBottom: "var(--s2)", fontWeight: 500 }}>
                Folder name
              </label>
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="New folder..."
                autoFocus
                style={{
                  width: "100%",
                  padding: "var(--s2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-sm)",
                  fontSize: "var(--fs-15)",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: "var(--s2)" }}>
              <button
                type="submit"
                style={{
                  padding: "var(--s2) var(--s3)",
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-contrast)",
                  border: "none",
                  borderRadius: "var(--r-sm)",
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowNewFolder(false);
                  setNewFolderName("");
                }}
                style={{
                  padding: "var(--s2) var(--s3)",
                  backgroundColor: "transparent",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-sm)",
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Error */}
        {error && (
          <div style={{ padding: "var(--s3)", backgroundColor: "#FAEAE9", color: "var(--alert)", borderRadius: "var(--r-md)", marginBottom: "var(--s4)" }}>
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && <div style={{ textAlign: "center", color: "var(--muted)" }}>Loading...</div>}

        {/* File List */}
        {!loading && nodes.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: "var(--s8)" }}>
            No files yet
          </div>
        )}

        {!loading && nodes.length > 0 && (
          <div style={{ display: "grid", gap: "var(--s2)" }}>
            {nodes.map((node) => (
              <div
                key={node.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "center",
                  padding: "var(--s3)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-md)",
                  backgroundColor: "var(--surface)",
                  gap: "var(--s3)",
                }}
              >
                <div>
                  {editingId === node.id ? (
                    <div style={{ display: "flex", gap: "var(--s2)" }}>
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        autoFocus
                        style={{
                          flex: 1,
                          padding: "var(--s2)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--r-sm)",
                          fontSize: "var(--fs-15)",
                        }}
                      />
                      <button
                        onClick={() => handleRename(node.id)}
                        style={{
                          padding: "var(--s2) var(--s3)",
                          backgroundColor: "var(--accent)",
                          color: "var(--accent-contrast)",
                          border: "none",
                          borderRadius: "var(--r-sm)",
                          cursor: "pointer",
                          fontWeight: 500,
                        }}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        style={{
                          padding: "var(--s2) var(--s3)",
                          backgroundColor: "transparent",
                          color: "var(--text)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--r-sm)",
                          cursor: "pointer",
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div>
                      {node.kind === "folder" ? (
                        <button
                          onClick={() => handleNavigateFolder(node.id, node.name)}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--accent)",
                            cursor: "pointer",
                            fontSize: "var(--fs-15)",
                            fontWeight: 500,
                            padding: 0,
                          }}
                        >
                          📁 {node.name}
                        </button>
                      ) : (
                        <div>
                          <span style={{ fontWeight: 500 }}>📄 {node.name}</span>
                          {node.size_bytes && (
                            <span style={{ display: "block", fontSize: "var(--fs-13)", color: "var(--muted)", marginTop: "var(--s1)" }}>
                              {(node.size_bytes / 1024).toFixed(1)} KB
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {editingId !== node.id && (
                  <div style={{ display: "flex", gap: "var(--s2)" }}>
                    {node.kind === "file" && (
                      <button
                        onClick={() => handleDownload(node.id, node.name)}
                        style={{
                          padding: "var(--s2) var(--s3)",
                          backgroundColor: "transparent",
                          color: "var(--text)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--r-sm)",
                          cursor: "pointer",
                          fontSize: "var(--fs-13)",
                        }}
                      >
                        Download
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setEditingId(node.id);
                        setEditingName(node.name);
                      }}
                      style={{
                        padding: "var(--s2) var(--s3)",
                        backgroundColor: "transparent",
                        color: "var(--text)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--r-sm)",
                        cursor: "pointer",
                        fontSize: "var(--fs-13)",
                      }}
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => handleDelete(node.id)}
                      style={{
                        padding: "var(--s2) var(--s3)",
                        backgroundColor: "transparent",
                        color: "var(--alert)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--r-sm)",
                        cursor: "pointer",
                        fontSize: "var(--fs-13)",
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
