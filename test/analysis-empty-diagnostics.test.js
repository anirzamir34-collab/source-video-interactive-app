import test from 'node:test';
import assert from 'node:assert/strict';
import { explainNoVerifiedActions } from '../public/analysis-empty-diagnostics.js';

test('zero model actions are not described as an empty source video', () => {
  const report = explainNoVerifiedActions({ modelRawActionsCount: 0, serverNormalizerAcceptedCount: 0 });
  assert.match(report.reason, /model hiçbir kaynak aksiyonu üretmedi/);
  assert.match(report.detail, /videoda hiçbir hareket olmadığı anlamına gelmez/);
});

test('raw actions removed on the server are distinguished from missing verification', () => {
  const server = explainNoVerifiedActions({ modelRawActionsCount: 8, serverNormalizerAcceptedCount: 0,
    serverNormalizerRejected: { invalidStructure: 6, lowConfidence: 2 } });
  assert.match(server.reason, /sunucuda geçemedi/);
  assert.match(server.detail, /yapı\/zaman 6/);
  const missingVerification = explainNoVerifiedActions({ modelRawActionsCount: 8,
    serverNormalizerAcceptedCount: 7, serverSourceVerifiedActionsCount: 0,
    clientNormalizerInputCount: 7, clientSourceVerifiedInputCount: 0 });
  assert.match(missingVerification.reason, /kaynak doğrulaması işaretlenmedi/);
});

test('client-ownership and integrity losses are diagnosed independently', () => {
  const client = explainNoVerifiedActions({ modelRawActionsCount: 9, serverNormalizerAcceptedCount: 8,
    serverSourceVerifiedActionsCount: 7, clientNormalizerInputCount: 8,
    clientSourceVerifiedInputCount: 7, clientNormalizerAcceptedCount: 0 });
  assert.match(client.reason, /karakter sahipliği/);
  const integrity = explainNoVerifiedActions({ modelRawActionsCount: 9, serverNormalizerAcceptedCount: 8,
    serverSourceVerifiedActionsCount: 7, clientNormalizerInputCount: 8,
    clientSourceVerifiedInputCount: 7, clientNormalizerAcceptedCount: 6, hardeningAcceptedCount: 0 });
  assert.match(integrity.reason, /bütünlük denetiminde elendi/);
});
