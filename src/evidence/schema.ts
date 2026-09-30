export const importedTypedEvidenceMigration = `
  CREATE TABLE IF NOT EXISTS imported_typed_evidence (
    producer_namespace TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    evidence_id TEXT NOT NULL,
    producer_version TEXT NOT NULL,
    context_revision TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('user-declared', 'agent-claimed')),
    kind TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK(resolution IN ('resolved', 'pending')),
    operation_source TEXT NOT NULL,
    operation_source_event_id TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    retained_at TEXT NOT NULL,
    PRIMARY KEY (producer_namespace, repository_id, session_id, evidence_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS imported_typed_evidence_pending
    ON imported_typed_evidence(repository_id, session_id, resolution);
`;

export const logicalAnnotationEvidenceMigration = `
  CREATE TABLE IF NOT EXISTS logical_annotation_evidence (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL,
    producer_namespace TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    PRIMARY KEY(session_id, ordinal),
    UNIQUE(session_id, producer_namespace, evidence_id),
    FOREIGN KEY(producer_namespace, repository_id, session_id, evidence_id)
      REFERENCES imported_typed_evidence(producer_namespace, repository_id, session_id, evidence_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS logical_annotation_evidence_identity
    ON logical_annotation_evidence(session_id, producer_namespace, evidence_id);
  CREATE TRIGGER IF NOT EXISTS logical_native_writer_sidecar_fence
    BEFORE INSERT ON logical_evidence
    WHEN EXISTS (SELECT 1 FROM logical_annotation_evidence a
      WHERE a.session_id = NEW.session_id AND a.ordinal >= NEW.ordinal)
    BEGIN SELECT RAISE(ABORT, 'Logical ordinal requires annotation-aware writer'); END;
  CREATE TRIGGER IF NOT EXISTS logical_annotation_writer_native_fence
    BEFORE INSERT ON logical_annotation_evidence
    WHEN EXISTS (SELECT 1 FROM logical_evidence n
      WHERE n.session_id = NEW.session_id AND n.ordinal >= NEW.ordinal)
    BEGIN SELECT RAISE(ABORT, 'Logical ordinal requires native-aware writer'); END;
`;

export const annotationRelationScopeMigration = `
  ALTER TABLE logical_annotation_evidence ADD COLUMN context_revision TEXT;
  ALTER TABLE logical_annotation_evidence ADD COLUMN kind TEXT;
  ALTER TABLE logical_annotation_evidence ADD COLUMN decision_key TEXT;
  ALTER TABLE logical_annotation_evidence ADD COLUMN scope_key TEXT;
  UPDATE logical_annotation_evidence SET
    context_revision = (SELECT i.context_revision FROM imported_typed_evidence i
      WHERE i.producer_namespace = logical_annotation_evidence.producer_namespace
        AND i.repository_id = logical_annotation_evidence.repository_id
        AND i.session_id = logical_annotation_evidence.session_id
        AND i.evidence_id = logical_annotation_evidence.evidence_id),
    kind = (SELECT i.kind FROM imported_typed_evidence i
      WHERE i.producer_namespace = logical_annotation_evidence.producer_namespace
        AND i.repository_id = logical_annotation_evidence.repository_id
        AND i.session_id = logical_annotation_evidence.session_id
        AND i.evidence_id = logical_annotation_evidence.evidence_id),
    decision_key = (SELECT json_extract(i.payload_json, '$.decisionKey') FROM imported_typed_evidence i
      WHERE i.producer_namespace = logical_annotation_evidence.producer_namespace
        AND i.repository_id = logical_annotation_evidence.repository_id
        AND i.session_id = logical_annotation_evidence.session_id
        AND i.evidence_id = logical_annotation_evidence.evidence_id),
    scope_key = (SELECT json_extract(i.payload_json, '$.scopeKey') FROM imported_typed_evidence i
      WHERE i.producer_namespace = logical_annotation_evidence.producer_namespace
        AND i.repository_id = logical_annotation_evidence.repository_id
        AND i.session_id = logical_annotation_evidence.session_id
        AND i.evidence_id = logical_annotation_evidence.evidence_id);
  CREATE INDEX logical_annotation_relation_scope ON logical_annotation_evidence
    (repository_id, session_id, producer_namespace, context_revision, kind, decision_key, scope_key, ordinal);
  CREATE TRIGGER logical_annotation_scope_writer_fence BEFORE INSERT ON logical_annotation_evidence
    WHEN NEW.context_revision IS NULL OR NEW.kind IS NULL OR NEW.decision_key IS NULL OR NEW.scope_key IS NULL
    BEGIN SELECT RAISE(ABORT, 'Annotation relation scope requires current writer'); END;
`;
