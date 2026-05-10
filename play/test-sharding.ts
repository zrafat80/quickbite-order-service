import assert from "node:assert";
import {db, dbArchive, pingAll, destroyAll} from "../src/lib/knex/knex";
import {isRegion, REGIONS, assertRegion} from "../src/lib/sharding/regions";

async function main() {
    console.log("configured regions:", [...REGIONS]);
    assert.ok(REGIONS.includes("eg"), "eg must be configured");
    assert.ok(REGIONS.includes("sa"), "sa must be configured");
    assert.ok(isRegion("eg"));
    assert.ok(isRegion("sa"));
    assert.ok(!isRegion("gb"));
    assert.ok(!isRegion(""));

    // assertRegion throws on unknown
    assert.throws(() => assertRegion("gb"), /Unknown region/);

    // the router returns the same Knex instance for the same (region, cluster)
    const egA = db("eg");
    const egB = db("eg");
    assert.strictEqual(egA, egB, "db('eg') must be a stable singleton per region");

    // but different for a different region
    const sa = db("sa");
    assert.notStrictEqual(egA, sa, "db('eg') and db('sa') must be different connections");

    // hot vs archive must differ
    const egArchive = dbArchive("eg");
    assert.notStrictEqual(egA, egArchive, "hot and archive connections must differ");

    // each connection targets a different database — check via raw query
    const [egName, saName, egArchiveName] = await Promise.all([
        egA.raw("SELECT current_database() AS db"),
        sa.raw("SELECT current_database() AS db"),
        egArchive.raw("SELECT current_database() AS db"),
    ]);
    console.log("eg      current_database:", egName.rows[0].db);
    console.log("sa      current_database:", saName.rows[0].db);
    console.log("eg.arc  current_database:", egArchiveName.rows[0].db);

    assert.strictEqual(egName.rows[0].db, "order_service_eg");
    assert.strictEqual(saName.rows[0].db, "order_service_sa");
    assert.strictEqual(egArchiveName.rows[0].db, "order_service_archive_eg");

    // pingAll returns per-shard status
    const pings = await pingAll();
    console.log("pingAll:", pings);
    for (const p of pings) assert.ok(p.ok, `${p.region}/${p.cluster} must be reachable`);

    await destroyAll();
    console.log("✅ sharding OK");
}

main().then(
    () => process.exit(0),
    (err) => {
        console.error("❌ sharding FAILED:", err);
        process.exit(1);
    },
);
