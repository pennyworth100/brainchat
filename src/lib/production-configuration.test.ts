import test from "node:test";
import assert from "node:assert/strict";
import { rootCertificates } from "node:tls";
import { productionConfiguration } from "./db/production-configuration";
const ca = rootCertificates[0];
const env = () => ({ DIMLE_PRODUCTION_RUNTIME_URL: "postgresql://runtime:fixture@db.example/production",
  DIMLE_PRODUCTION_MAINTENANCE_URL: "postgresql://maintenance:fixture@db.example/production" });
test("production configuration accepts exactly two explicit restricted authority URLs and pins TLS", () => {
  const c = productionConfiguration({...env(),DATABASE_URL:"invalid://ignored",PGSSLMODE:"disable"},ca);
  assert.deepEqual(c.roles,["runtime","maintenance"]);
  assert.equal(c.database,"production");
  for (const config of c.configs) {
    assert.deepEqual(config.ssl,{ca,rejectUnauthorized:true});
    assert.equal(config.options,"-c search_path=pg_catalog,public,pg_temp");
  }
});
test("production configuration rejects driver bypasses, mixed authorities and secret-bearing errors", () => {
  for (const value of [undefined,"postgresql://runtime:secret@other.example/production",
    "postgresql://runtime:secret@db.example/other", "postgresql://maintenance:secret@db.example/production",
    "postgresql://runtime:secret@db.example/production?sslmode=disable",
    "postgresql://runtime:secret@db.example/production?options=unsafe",
    "postgresql://runtime:secret@db.example/prod%2Fother", "postgresql://runtime:secret@db.example/production#x",
    "postgresql://runtime@db.example/production", "postgresql://%ZZ:secret@db.example/production"]) {
    assert.throws(() => productionConfiguration({...env(), DIMLE_PRODUCTION_RUNTIME_URL:value},ca),
      (e: Error) => !e.message.includes("secret"));
  }
  assert.throws(() => productionConfiguration({...env(),DIMLE_PRODUCTION_MIGRATION_URL:"secret"},ca));
  assert.throws(() => productionConfiguration(env(),"-----BEGIN CERTIFICATE-----\ninvalid"));
  assert.throws(() => productionConfiguration({DATABASE_URL:env().DIMLE_PRODUCTION_RUNTIME_URL},ca));
});
