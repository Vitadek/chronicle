#!/usr/bin/env bash
set -Eeuo pipefail

FORMAL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$FORMAL_DIR/../.." && pwd)
COMPOSE_FILE="$FORMAL_DIR/compose.yml"
ARTIFACTS="$FORMAL_DIR/artifacts"

export CHRONICLE_IMAGE=${CHRONICLE_IMAGE:-forgejo.lan/protoman/chronicle:core-candidate-20260713-r5}
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-chronicle-formal}
export COMPOSE_ANSI=${COMPOSE_ANSI:-never}
export BUILDKIT_PROGRESS=${BUILDKIT_PROGRESS:-plain}

compose() {
  docker compose --file "$COMPOSE_FILE" "$@"
}

wait_for_chronicle_health() {
  local container status
  container=$(compose ps --quiet chronicle)
  if [ -z "$container" ]; then
    echo "Chronicle container is not running" >&2
    return 1
  fi
  for _ in $(seq 1 90); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
    if [ "$status" = healthy ]; then
      return 0
    fi
    if [ "$status" = exited ] || [ "$status" = dead ]; then
      compose logs --no-color chronicle >&2
      return 1
    fi
    sleep 1
  done
  echo "Chronicle did not become healthy" >&2
  compose logs --no-color chronicle >&2
  return 1
}

capture_and_clean() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  compose ps --all >"$ARTIFACTS/compose-ps.txt" 2>&1
  compose logs --no-color --timestamps >"$ARTIFACTS/compose.log" 2>&1
  docker image inspect "$CHRONICLE_IMAGE" >"$ARTIFACTS/chronicle-image-inspect.json" 2>&1
  compose config >"$ARTIFACTS/compose-resolved.yml" 2>&1
  compose down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1
  exit "$status"
}

trap capture_and_clean EXIT INT TERM

mkdir -p "$ARTIFACTS"
find "$ARTIFACTS" -depth -mindepth 1 ! -name .gitkeep -delete
chmod 0777 "$ARTIFACTS"

cd "$ROOT_DIR"
compose down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true

if ! docker image inspect "$CHRONICLE_IMAGE" >/dev/null 2>&1; then
  docker pull "$CHRONICLE_IMAGE"
fi

docker image inspect --format 'Testing Chronicle image {{.Id}} ({{join .RepoTags ", "}})' "$CHRONICLE_IMAGE" \
  | tee "$ARTIFACTS/image-under-test.txt"

REPORT_DIR="$ARTIFACTS" node "$FORMAL_DIR/orchestrator/preflight.mjs" \
  | tee "$ARTIFACTS/preflight.tap"

compose build runner
compose up --detach --wait chronicle

compose run --rm --no-deps runner node specs/run.mjs foundation \
  | tee "$ARTIFACTS/foundation.tap"

compose exec -T chronicle node dist/cli.cjs verify \
  | tee "$ARTIFACTS/verify-before-outage.json"

compose run --rm --no-deps runner node specs/run.mjs outage \
  | tee "$ARTIFACTS/outage.tap"

set +e
compose exec -T chronicle node dist/cli.cjs status >"$ARTIFACTS/status-during-outage.json" 2>&1
degraded_status=$?
set -e
if [ "$degraded_status" -ne 2 ]; then
  echo "Expected degraded storage CLI status 2, got $degraded_status" >&2
  cat "$ARTIFACTS/status-during-outage.json" >&2
  exit 1
fi

compose run --rm --no-deps runner node orchestrator/toxiproxy.mjs enable \
  | tee "$ARTIFACTS/toxiproxy-recovery.txt"

compose exec -T chronicle node dist/cli.cjs retry \
  | tee "$ARTIFACTS/retry.json"

compose exec -T chronicle node dist/cli.cjs verify \
  | tee "$ARTIFACTS/verify-after-recovery.json"

compose run --rm --no-deps runner node specs/run.mjs recovery \
  | tee "$ARTIFACTS/recovery.tap"

compose exec -T chronicle node dist/cli.cjs backup --output /data/formal-backup.db \
  | tee "$ARTIFACTS/backup.json"
compose exec -T chronicle test -s /data/formal-backup.db
compose cp chronicle:/data/formal-backup.db "$ARTIFACTS/formal-backup.db" >/dev/null
sha256sum "$ARTIFACTS/formal-backup.db" | tee "$ARTIFACTS/formal-backup.sha256"

compose restart chronicle
wait_for_chronicle_health

compose run --rm --no-deps runner node specs/run.mjs durability \
  | tee "$ARTIFACTS/durability.tap"

compose exec -T chronicle node dist/cli.cjs verify \
  | tee "$ARTIFACTS/verify-after-restart.json"

compose run --rm --no-deps runner node specs/run.mjs pre_restore \
  | tee "$ARTIFACTS/pre-restore.tap"

alice_id=$(node -e \
  'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).aliceId)' \
  "$ARTIFACTS/restore-baseline.json")

# The recovery snapshot is already sealed in MinIO and every later local write
# is a dead letter. Stop the sole SQLite writer before reconnecting the remote.
compose stop --timeout 15 chronicle
if [ -n "$(compose ps --status running --quiet chronicle)" ]; then
  echo "Chronicle must be stopped before restore apply" >&2
  exit 1
fi

compose run --rm --no-deps runner node orchestrator/toxiproxy.mjs enable \
  | tee "$ARTIFACTS/toxiproxy-restore-enable.txt"

compose run --rm --no-deps chronicle node dist/cli.cjs restore \
  | tee "$ARTIFACTS/restore-dry-run-all.json"
compose run --rm --no-deps chronicle node dist/cli.cjs restore --user "$alice_id" \
  | tee "$ARTIFACTS/restore-dry-run-user.json"
compose run --rm --no-deps runner node orchestrator/assert-restore-artifacts.mjs dry-runs \
  | tee "$ARTIFACTS/restore-dry-run-assertion.txt"

set +e
compose run --rm --no-deps chronicle node dist/cli.cjs restore --apply \
  >"$ARTIFACTS/restore-apply-without-force.txt" 2>&1
refusal_status=$?
set -e
if [ "$refusal_status" -ne 1 ] || \
   ! grep -F -- '--apply --force' "$ARTIFACTS/restore-apply-without-force.txt" >/dev/null; then
  echo "Restore --apply did not refuse existing records as expected" >&2
  cat "$ARTIFACTS/restore-apply-without-force.txt" >&2
  exit 1
fi

compose run --rm --no-deps chronicle node dist/cli.cjs restore --apply --force \
  | tee "$ARTIFACTS/restore-apply-force.json"
compose run --rm --no-deps runner node orchestrator/assert-restore-artifacts.mjs apply \
  | tee "$ARTIFACTS/restore-apply-assertion.txt"

backup_path=$(node -e \
  'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backupPath;if(!/^\/data\/chronicle-before-restore-[A-Za-z0-9-]+\.db$/.test(p))process.exit(1);process.stdout.write(p)' \
  "$ARTIFACTS/restore-apply-force.json")

compose run --rm --no-deps --no-TTY \
  -e BACKUP_PATH="$backup_path" -e ALICE_ID="$alice_id" \
  chronicle node - >"$ARTIFACTS/automatic-backup-verification.json" <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(process.env.BACKUP_PATH, { readonly: true, fileMustExist: true });
const alice = process.env.ALICE_ID;
const one = (sql, ...args) => db.prepare(sql).get(...args);
const count = (table) => one(`SELECT COUNT(*) AS n FROM ${table}`).n;
const authoritativeRevisions = [];
for (const row of db.prepare(`
  SELECT id, revision, deleted_at FROM manuscripts WHERE user_id = ? ORDER BY id
`).all(alice)) {
  authoritativeRevisions.push({
    entity: 'manuscript', id: row.id,
    operation: row.deleted_at === null ? 'upsert' : 'delete', revision: row.revision,
  });
}
for (const row of db.prepare(`
  SELECT manuscript_id, id, revision, deleted_at
  FROM chapters WHERE user_id = ? ORDER BY manuscript_id, id
`).all(alice)) {
  authoritativeRevisions.push({
    entity: 'chapter', manuscriptId: row.manuscript_id, id: row.id,
    operation: row.deleted_at === null ? 'upsert' : 'delete', revision: row.revision,
  });
}
for (const row of db.prepare('SELECT revision FROM profiles WHERE user_id = ?').all(alice)) {
  authoritativeRevisions.push({ entity: 'profile', id: 'profile', operation: 'upsert', revision: row.revision });
}
authoritativeRevisions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const settingsRow = one('SELECT content FROM storage_blobs WHERE key = ?', `settings/${alice}`);
const durableManuscript = one(
  'SELECT data, revision FROM manuscripts WHERE user_id = ? AND id = ?', alice, 'formal_durable',
);
const durableChapter = one(`
  SELECT content, revision FROM chapters
  WHERE user_id = ? AND manuscript_id = ? AND id = ?
`, alice, 'formal_durable', 'collab');
const deletedManuscript = one(
  'SELECT data FROM manuscripts WHERE user_id = ? AND id = ?', alice, 'formal_restore_deleted',
);
const deletedChapter = one(`
  SELECT title, content, position FROM chapters
  WHERE user_id = ? AND manuscript_id = ? AND id = ?
`, alice, 'formal_restore_deleted', 'secret');
const outageManuscript = one(`
  SELECT data, deleted_at, revision FROM manuscripts WHERE user_id = ? AND id = ?
`, alice, 'formal_outage');
const outageChapter = one(`
  SELECT title, content, position, deleted_at, revision FROM chapters
  WHERE user_id = ? AND manuscript_id = ? AND id = ?
`, alice, 'formal_outage', 'offline');
const blobs = db.prepare(`
  SELECT key, lower(hex(content)) AS hex FROM storage_blobs ORDER BY key
`).all();
const outbox = db.prepare(`
  SELECT key, operation, dead_letter AS deadLetter
  FROM storage_replication_outbox ORDER BY key
`).all();
const result = {
  backupPath: process.env.BACKUP_PATH,
  integrity: db.pragma('integrity_check')[0].integrity_check,
  epoch: one("SELECT v FROM kv WHERE k = 'sync:history-epoch:v2'").v,
  authoritativeRevisions,
  settings: JSON.parse(Buffer.from(settingsRow.content).toString('utf8')),
  durable: {
    title: JSON.parse(durableManuscript.data).title,
    manuscriptRevision: durableManuscript.revision,
    chapterContent: durableChapter.content,
    chapterRevision: durableChapter.revision,
  },
  deleted: {
    manuscriptData: deletedManuscript.data,
    chapterTitle: deletedChapter.title,
    chapterContent: deletedChapter.content,
    chapterPosition: deletedChapter.position,
    collaborationRows: one(
      'SELECT COUNT(*) AS n FROM ydocs WHERE name = ? OR name = ?',
      `${encodeURIComponent(alice)}/formal_restore_deleted:secret`,
      'formal_restore_deleted:secret',
    ).n,
    preCollaborationRows: one(`
      SELECT COUNT(*) AS n FROM chapter_pre_collab
      WHERE user_id = ? AND manuscript_id = ? AND chapter_id = ?
    `, alice, 'formal_restore_deleted', 'secret').n,
  },
  outage: {
    manuscriptData: outageManuscript.data,
    manuscriptDeletedAt: outageManuscript.deleted_at,
    manuscriptRevision: outageManuscript.revision,
    chapterTitle: outageChapter.title,
    chapterContent: outageChapter.content,
    chapterPosition: outageChapter.position,
    chapterDeletedAt: outageChapter.deleted_at,
    chapterRevision: outageChapter.revision,
  },
  profile: JSON.parse(one('SELECT data FROM profiles WHERE user_id = ?', alice).data),
  blobs,
  outbox,
  counts: {
    users: count('users'),
    manuscripts: count('manuscripts'),
    chapters: count('chapters'),
    profiles: count('profiles'),
    storageBlobs: count('storage_blobs'),
    replicaManifest: count('storage_replica_manifest'),
    replicaOutbox: count('storage_replication_outbox'),
  },
};
db.close();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
NODE

compose run --rm --no-deps runner node orchestrator/assert-restore-artifacts.mjs backup \
  | tee "$ARTIFACTS/automatic-backup-assertion.txt"
compose cp "chronicle:$backup_path" "$ARTIFACTS/automatic-pre-restore.db" >/dev/null
test -s "$ARTIFACTS/automatic-pre-restore.db"
sha256sum "$ARTIFACTS/automatic-pre-restore.db" \
  | tee "$ARTIFACTS/automatic-pre-restore.sha256"

if [ -n "$(compose ps --status running --quiet chronicle)" ]; then
  echo "Canonical Chronicle unexpectedly started during offline restore" >&2
  exit 1
fi
compose start chronicle
wait_for_chronicle_health

compose run --rm --no-deps runner node specs/run.mjs post_restore \
  | tee "$ARTIFACTS/post-restore.tap"

compose exec -T chronicle node dist/cli.cjs verify \
  | tee "$ARTIFACTS/verify-after-offline-restore.json"
compose run --rm --no-deps runner node orchestrator/assert-restore-artifacts.mjs verify \
  | tee "$ARTIFACTS/verify-after-offline-restore-assertion.txt"

echo "Formal Chronicle suite passed. Artifacts: $ARTIFACTS"
