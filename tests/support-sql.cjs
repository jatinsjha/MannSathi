const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {PGlite} = require(process.env.PGLITE_MODULE_PATH || path.resolve(".preview/sql-runtime/node_modules/@electric-sql/pglite"));
const {randomUUID} = require("node:crypto");

(async()=>{
    const db=new PGlite();
    try {
        await db.exec("create role anon; create role authenticated; create role service_role;");
        await db.exec(`create schema cron;
          create table cron.jobs(jobname text, cadence text, command text);
          create function cron.schedule(text,text,text) returns bigint language plpgsql as $$
          begin insert into cron.jobs values ($1,$2,$3);return 1;end $$;`);
        await db.exec(fs.readFileSync("database/migrations/011_support_inbox.sql","utf8"));
        assert.deepEqual((await db.query("select * from cron.jobs")).rows[0],{
            jobname:"mannsathi-support-retention",cadence:"17 * * * *",command:"select mannsathi_support_private.prune()"
        });
        const args=[randomUUID(),"bug",null,"The calendar did not refresh.","a".repeat(64)];
        const sql="select public.mannsathi_submit_support($1,$2,$3,$4,$5) as reference";
        await db.exec("set role service_role");
        assert.equal((await db.query(sql,args)).rows[0].reference,args[0]);
        assert.equal((await db.query(sql,args)).rows[0].reference,args[0]);
        for(let i=1;i<5;i++) await db.query(sql,[randomUUID(),...args.slice(1)]);
        await assert.rejects(db.query(sql,[randomUUID(),...args.slice(1)]),{code:"PT429"});
        await db.exec("reset role");
        const read=(await db.query("select count(*)::int as n from mannsathi_support_private.requests")).rows[0];
        assert.equal(read.n,5);
        const permissions=await db.query("select has_function_privilege('anon','public.mannsathi_submit_support(uuid,text,text,text,text)','execute') as submit, has_schema_privilege('authenticated','mannsathi_support_private','usage') as browse");
        assert.deepEqual(permissions.rows[0],{submit:false,browse:false});
        await db.query("update mannsathi_support_private.requests set received_at=now()-interval '91 days' where id=$1",[args[0]]);
        await db.exec("update mannsathi_support_private.requests set received_at=now()-interval '25 hours' where received_at>now()-interval '1 hour'; select mannsathi_support_private.prune();");
        assert.deepEqual((await db.query("select count(*)::int as n, count(source_digest)::int as hashes from mannsathi_support_private.requests")).rows[0],{n:4,hashes:0});
        console.log("PASS private inbox, idempotent submissions, rate limits, grants and retention.");
    } finally {await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
