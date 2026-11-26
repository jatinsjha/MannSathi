from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import ModuleType, SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from scripts import sync_ai_provider as sync


END = datetime(2026, 6, 1, 12, tzinfo=UTC)
START = END - timedelta(minutes=1)
NAME = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"
BASE = "generate_content_free_tier_requests"


def series(kind, points, method="generateContent"):
    return {"metricKind":kind,"valueType":"INT64","metric":{"labels":{"method":method}},
            "points":[{"interval":{"startTime":sync.stamp(a),"endTime":sync.stamp(b)},
                       "value":{"int64Value":str(v)}} for a,b,v in points]}


class ProviderTests(TestCase):
    def test_google_limit_window_and_dimensions(self):
        self.assertEqual(sync.classify(BASE, NAME), "RPM")
        self.assertEqual(sync.classify(BASE, NAME.replace("Minute","Day")), "RPD")
        self.assertEqual(sync.classify("generate_content_paid_tier_2_input_token_count","GenerateContentInputTokensPerModelPerMinute-PaidTier"), "TPM")
        self.assertEqual(sync.classify("generate_requests_per_model",NAME.replace("-FreeTier","")), "RPM")
        for base,name in ((BASE, NAME.replace("PerProject","PerUser")), (BASE,NAME.replace("Minute","DayPerMinute")),
                          ("generate_content_paid_tier_2_input_token_count",NAME)):
            with self.assertRaises(ValueError):
                sync.classify(base,name)
        with self.assertRaises(ValueError):
            sync.classify(BASE, "DailyLimit")
        with self.assertRaises(ValueError):
            sync.classify("other_service", NAME)
        day, through = sync.window("RPD", END)
        self.assertEqual(day.hour, 7)  # June is PDT; midnight is 07:00 UTC
        self.assertEqual(through, END-timedelta(minutes=5))

    def test_sparse_unknown_explicit_zero_and_pagination(self):
        mid = START + timedelta(seconds=30)
        first = series("DELTA", [(START, mid, 2)])
        second = series("DELTA", [(mid, END, 3)])
        third = series("DELTA", [(START, END, 7)], "batch")
        self.assertEqual(sync.consumption([second, third, first], START, END), 12)
        self.assertIsNone(sync.consumption([],START,END))
        self.assertIsNone(sync.consumption([second],START,END))
        self.assertIsNone(sync.consumption([second,first,first],START,END))
        self.assertEqual(sync.consumption([series("DELTA",[(START,END,0)])],START,END),0)

    def test_unmeasured_or_inconsistent_limit(self):
        with self.assertRaises(ValueError):
            sync.limit_window([series("GAUGE",[(START,START,10)])],START,END)
        with self.assertRaises(ValueError):
            sync.limit_window([series("GAUGE",[(END,END,11),(END,END,10)])],START,END)
        with self.assertRaises(ValueError):
            sync.limit_window([series("GAUGE",[(START,END,10)])],START,END)
        earlier = START-timedelta(minutes=1)
        self.assertEqual(sync.limit_window([series("GAUGE",[(END,END,10)])],earlier,END),(10,False))
        self.assertEqual(sync.limit_window([series("GAUGE",[(START,START,9),(END,END,10)])],earlier,END),(10,False))
        self.assertEqual(sync.limit_window([series("GAUGE",[(START,START,10),(END,END,10)])],earlier,END),(10,True))
        self.assertIsNone(sync.consumption([series("DELTA",[(START-timedelta(seconds=1),END,2)])],START,END))
        with self.assertRaises(ValueError):
            sync.consumption([series("DELTA",[(START,END,-1)])],START,END)

    def test_rejects_mismatched_dimensions_and_incomplete_pages(self):
        item = {"metric":{"type":"example/usage","labels":{"model":"model", "limit_name":NAME,"method":"generateContent"}},
                "resource":{"type":sync.SERVICE+"/Location","labels":{"project_id":"my-project","location":"global"}}}
        session = Mock()
        session.get.return_value.status_code = 200
        def read():
            return sync.time_series(session,"my-project","model","example/usage",NAME,START,END)
        session.get.return_value.json.return_value = {"timeSeries":[item]}
        self.assertEqual(read(),[item])
        for resource in ({"project_id":"wrong","location":"global"},{"project_id":"my-project","location":"us-east1"},
                         {"project_id":"my-project","location":"global","zone":"abc"}):
            session.get.return_value.json.return_value={"timeSeries":[{**item,"resource":{**item["resource"],"labels":resource}}]}
            with self.assertRaises(ValueError):
                read()
        for label in ({"model":"other"},{"tier":"extra"},{"limit_name":"other"},{"method":""}):
            metric = {**item["metric"],"labels":{**item["metric"]["labels"],**label}}
            session.get.return_value.json.return_value={"timeSeries":[{**item,"metric":metric}]}
            with self.assertRaises(ValueError):
                read()
        for data in ({"executionErrors":[{}]}, {"nextPageToken":"repeated"}):
            session.get.return_value.json.return_value = data
            with self.assertRaises(ValueError):
                read()

    @patch.object(sync,"rpc")
    @patch.object(sync,"time_series")
    def test_limit_only_import_does_not_invent_usage(self, read, write):
        read.side_effect = [[series("GAUGE",[(END,END,100)])],[]]
        self.assertFalse(sync.sync_quota(None,"my-project","model",BASE,NAME,END+timedelta(minutes=5)))
        _,payload = write.call_args.args
        self.assertIsNone(payload["p_usage"])
        self.assertEqual(payload["p_limit"],100)
        self.assertEqual(payload["p_end"],sync.stamp(END))

    @patch.object(sync,"rpc")
    def test_billing_only_writes_scoped_complete_usd_export(self, write):
        cloud=ModuleType("google.cloud")
        bigquery=Mock()
        cloud.bigquery=bigquery
        table="my-project.billing.gcp_billing_export_v1_123456_ABCDEF_987654"
        client=bigquery.Client.return_value
        job=client.query.return_value
        data=dict(entries=1,incomplete=0,other_currency=0,source_project="my-project",source_service=sync.SERVICE_ID,
                  first_usage=START,last_usage=START,updated=END,amount=Decimal("0.00000"))
        with patch.dict("sys.modules", {"google.cloud":cloud,"google.cloud.bigquery":bigquery}):
            def run(changes):
                job.result.return_value=[SimpleNamespace(**{**data,**changes})]
                sync.sync_billing(None,"my-project",table,"US",123456,END)
            for changes in ({"entries":0},{"incomplete":1},{"other_currency":1},{"amount":None},{"amount":Decimal("NaN")},
                            {"source_project":"wrong"},{"source_service":"other"},{"first_usage":START-timedelta(days=1)},
                            {"last_usage":END},{"updated":END+timedelta(seconds=1)},{"updated":None}):
                with self.assertRaises(ValueError):
                    run(changes)
            write.assert_not_called()
            for amount in [Decimal("0"),Decimal("3.25")]:
                run({"amount":amount})
                name, payload=write.call_args.args
                self.assertEqual(name,"mannsathi_ai_import_billing")
                self.assertEqual(payload,{"p_project":"my-project","p_month":"2026-06-01","p_amount":str(amount),"p_through":sync.stamp(END)})
            sql=client.query.call_args.args[0]
            self.assertIn("project.id = @project AND service.id = @service",sql)
            self.assertIn("cost IS NULL",sql)
            self.assertIn("WHERE c.amount IS NULL",sql)
            self.assertEqual(bigquery.QueryJobConfig.call_args.kwargs["maximum_bytes_billed"],123456)
