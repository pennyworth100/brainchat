import test from "node:test";
import assert from "node:assert/strict";
import { candidateConfiguration } from "./db/candidate-configuration";
const ca = "-----BEGIN CERTIFICATE-----\nfixture";
const env = () => Object.fromEntries(["MIGRATION","RUNTIME","MAINTENANCE"].map(role =>
  [`DIMLE_CANDIDATE_${role}_URL`, `postgresql://${role.toLowerCase()}:secret@db.example/candidate` ]));
test("private candidate pins TLS and search_path for three explicit roles", () => {
  const result = candidateConfiguration(env(),ca);
  assert.equal(result.database,"candidate");
  assert.equal(new Set(result.roles).size,3);
  for (const config of result.configs) {
    assert.deepEqual(config.ssl,{ca,rejectUnauthorized:true});
    assert.equal(config.options,"-c search_path=pg_catalog,public,pg_temp");
  }
});
test("candidate rejects missing roles, shared identity, cross-db and driver override", () => {
  for (const value of [undefined,"postgresql://runtime:secret@db.example/other",
    "postgresql://runtime:secret@evil.example/candidate","postgresql://migration:secret@db.example/candidate",
    "postgresql://runtime:secret@db.example/candidate?sslmode=disable",
    "postgresql://runtime:secret@db.example/candidate?options=unsafe",
    "postgresql://runtime@db.example/candidate","http://runtime:secret@db.example/candidate"]) {
    assert.throws(() => candidateConfiguration({...env(),DIMLE_CANDIDATE_RUNTIME_URL:value},ca));
  }
  assert.throws(() => candidateConfiguration(env(),""));
  assert.throws(() => candidateConfiguration({DATABASE_URL:"postgresql://admin:secret@db.example/prod"},ca));
});
