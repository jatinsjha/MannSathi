"""Import observed Google Cloud data from a trusted machine. See docs/ai-administration.md."""
import argparse
import os
import re
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from api.shared.ai_service import configured_model, rpc
from api.shared.supabase import ApiError


SERVICE = "generativelanguage.googleapis.com"
PROJECT = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]")
BASE = re.compile(r"generate_content_(?:free_tier|paid_tier(?:_[1-9][0-9]*)?)_(requests|input_token_count)")
TABLE = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]*\.gcp_billing_export_(?:resource_)?v1_[A-Za-z0-9_]+")
SERVICE_ID = "AEFD-7695-64FA"


def stamp(value):
    if value.tzinfo is None:
        raise ValueError("Observation timestamps require a timezone.")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def date_value(value):
    if not isinstance(value, str) or not re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6}0{0,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})", value):
        raise ValueError("Invalid or unsupported Google observation timestamp.")
    instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if instant.tzinfo is None:
        raise ValueError("Missing Google observation timezone.")
    return instant


def classify(base, name):
    match = BASE.fullmatch(base)
    if (not match and base != "generate_requests_per_model") or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", name):
        raise ValueError("Use a supported Google quota metric and its exact limit name.")
    token_metric = bool(match and match[1] == "input_token_count")
    label = name.lower()
    # Reject extra dimensions (for example, per-user or per-region quotas).
    periods = re.findall(r"Per([A-Z][a-z]+)", name)
    if (sorted(periods) not in (["Day","Model","Project"], ["Minute","Model","Project"],["Minute","Model"],["Day","Model"])
            or ("token" in label) != token_metric or (not token_metric and "request" not in label)
            or ("freetier" in label and "paid_tier" in base)):
        raise ValueError("Only per-project, per-model limits can be assigned to a model.")
    if "perminute" in label and "perday" not in label:
        return "TPM" if token_metric else "RPM"
    if "perday" in label and "perminute" not in label and not token_metric:
        return "RPD"
    raise ValueError("The Google limit name does not identify a supported time window.")


def window(metric, now):
    # Google documents reporting lag. Select a finished observation window.
    end = (now.astimezone(UTC) - timedelta(minutes=5)).replace(second=0, microsecond=0)
    if metric == "RPD":
        pacific = ZoneInfo("America/Los_Angeles")
        start = datetime.combine((end-timedelta(microseconds=1)).astimezone(pacific).date(), time.min, pacific)
        return start.astimezone(UTC), end
    return end-timedelta(minutes=1), end


def time_series(session, project, model, metric_type, limit_name, start, end):
    url = f"https://monitoring.googleapis.com/v3/projects/{project}/timeSeries"
    query = {"filter": f'metric.type="{metric_type}" AND metric.labels.model="{model}" AND '
             f'metric.labels.limit_name="{limit_name}" AND resource.type="{SERVICE}/Location" '
             f'AND project="{project}"',
             "interval.startTime": stamp(start), "interval.endTime": stamp(end), "view": "FULL", "pageSize": 1000}
    series, tokens = [], set()
    for _ in range(50):
        response = session.get(url, params=query, timeout=25, allow_redirects=False)
        if response.status_code != 200:
            raise ValueError(f"Cloud Monitoring returned HTTP {response.status_code}. Check project, metric, and IAM.")
        data = response.json()
        if not isinstance(data, dict) or data.get("executionErrors") or data.get("unreachable"):
            raise ValueError("Cloud Monitoring returned a partial result.")
        for item in data.get("timeSeries", []):
            metric = item["metric"]
            resource = item["resource"]
            labels = metric["labels"]
            resource_labels = resource["labels"]
            project_labels = {k:v for k,v in resource_labels.items() if k in {"project_id","resource_container"}}
            allowed = {"model","limit_name","method"} if metric_type.endswith("/usage") else {"model","limit_name"}
            if (metric["type"] != metric_type or set(labels) != allowed or labels.get("model") != model
                    or labels.get("limit_name") != limit_name or ("method" in allowed and not labels.get("method"))
                    or resource["type"] != SERVICE+"/Location" or len(project_labels) != 1
                    or next(iter(project_labels.values())) not in {project, "projects/"+project}
                    or set(resource_labels)-{"project_id","resource_container","location"} or resource_labels.get("location") != "global"
                    or (item.get("unit") not in (None,"1"))):
                raise ValueError("Cloud Monitoring returned a different quota scope.")
            series.append(item)
        if not data.get("nextPageToken"):
            return series
        token = data["nextPageToken"]
        if not isinstance(token, str) or token in tokens:
            raise ValueError("Cloud Monitoring returned an invalid continuation.")
        tokens.add(token)
        query["pageToken"] = token
    raise ValueError("Cloud Monitoring result exceeded the import size limit.")


def as_count(point):
    raw = point["value"].get("int64Value")
    if not isinstance(raw, str) or not re.fullmatch(r"[0-9]{1,19}", raw) or int(raw) >= 2**63:
        raise ValueError("Invalid Google quota measurement.")
    return int(raw)


def limit_window(series, start, end):
    observations = {}
    for item in series:
        if item["metricKind"] != "GAUGE" or item["valueType"] != "INT64":
            raise ValueError("Unsupported limit metric type.")
        for point in item["points"]:
            interval = point["interval"]
            at = date_value(interval["endTime"])
            if interval.get("startTime") and date_value(interval["startTime"]) != at:
                raise ValueError("A GAUGE limit must be an instantaneous observation.")
            if at <= start or at > end:
                raise ValueError("Google returned a quota limit outside the requested window.")
            count = as_count(point)
            if at in observations and observations[at] != count:
                raise ValueError("Google returned conflicting limit observations.")
            observations[at] = count
    if end not in observations:
        raise ValueError("No unambiguous reported limit at the end of the selected window.")
    value = observations[end]
    # The published limit is sampled every 60 seconds. A changed or sparse daily
    # limit can be displayed at its timestamp, but cannot qualify a percentage.
    expected = start + timedelta(minutes=1)
    while expected <= end:
        if observations.get(expected) != value:
            return value, False
        expected += timedelta(minutes=1)
    return value, all(v == value for v in observations.values())


def consumption(series, start, end):
    # Queries can be paginated within a series. Require full, contiguous, nonoverlapping
    # DELTAs for every returned method. Sparse observations cannot establish a zero.
    groups = {}
    for item in series:
        if item["metricKind"] != "DELTA" or item["valueType"] != "INT64":
            raise ValueError("Unsupported quota consumption metric type.")
        key = tuple(sorted(item["metric"]["labels"].items()))
        group = groups.setdefault(key, [])
        for point in item["points"]:
            interval = point["interval"]
            group.append((date_value(interval["startTime"]),date_value(interval["endTime"]),as_count(point)))
    if not groups:
        return None
    total = 0
    for intervals in groups.values():
        cursor = start
        for left,right,count in sorted(intervals):
            if left != cursor or left >= right or right > end:
                return None
            total += count
            if total >= 2**63:
                raise ValueError("Google consumption exceeds a supported count.")
            cursor = right
        if cursor != end:
            return None
    return total


def sync_quota(session, project, model, base, limit_name, now):
    metric = classify(base, limit_name)
    start,end = window(metric, now)
    metric_id = f"{SERVICE}/quota/{base}"
    limits = time_series(session, project, model, metric_id+"/limit", limit_name, start, end)
    measured_limit, same_window = limit_window(limits, start, end)
    measured_usage = None
    if same_window:
        usage = time_series(session, project, model, metric_id+"/usage", limit_name, start, end)
        measured_usage = consumption(usage, start, end)
    rpc("mannsathi_ai_import_quota", {"p_project":project,"p_model":model,"p_metric":metric,"p_metric_id":metric_id,
        "p_limit_name":limit_name,"p_start":stamp(start),"p_end":stamp(end),"p_limit":measured_limit,"p_usage":measured_usage})
    return measured_usage is not None


def sync_billing(creds, project, table, location, byte_limit, now):
    if not TABLE.fullmatch(table):
        raise ValueError("Select a fully qualified standard or detailed Cloud Billing export table.")
    from google.cloud import bigquery
    client = bigquery.Client(project=project, credentials=creds, location=location)
    month = now.astimezone(UTC).replace(day=1,hour=0,minute=0,second=0,microsecond=0)
    sql = f"""
        SELECT ANY_VALUE(project.id) AS source_project, ANY_VALUE(service.id) AS source_service,
               COUNT(*) AS entries, COUNTIF(currency IS NULL OR currency != 'USD') AS other_currency,
               COUNTIF(cost IS NULL OR export_time IS NULL OR EXISTS (
                   SELECT 1 FROM UNNEST(credits) AS c WHERE c.amount IS NULL)) AS incomplete,
               MIN(usage_start_time) AS first_usage, MAX(usage_start_time) AS last_usage,
               SUM(CAST(cost AS NUMERIC) + IFNULL((SELECT SUM(CAST(c.amount AS NUMERIC))
                    FROM UNNEST(credits) AS c), 0)) AS amount, MAX(export_time) AS updated
          FROM `{table}`
         WHERE project.id = @project AND service.id = @service
           AND usage_start_time >= @start AND usage_start_time < @end
    """
    params = [bigquery.ScalarQueryParameter("project","STRING",project),
              bigquery.ScalarQueryParameter("service","STRING",SERVICE_ID),
              bigquery.ScalarQueryParameter("start","TIMESTAMP",month),bigquery.ScalarQueryParameter("end","TIMESTAMP",now)]
    job = client.query(sql,job_config=bigquery.QueryJobConfig(query_parameters=params,maximum_bytes_billed=byte_limit))
    rows = list(job.result(timeout=60))
    if len(rows) != 1:
        raise ValueError("No usable USD billing total was reported for this project and month.")
    row = rows[0]
    if (not row.entries or row.other_currency != 0 or row.incomplete != 0
            or row.source_project != project or row.source_service != SERVICE_ID or row.amount is None
            or not all(isinstance(t,datetime) and t.tzinfo is not None for t in (row.first_usage,row.last_usage,row.updated))
            or not month <= row.first_usage <= row.last_usage < now or not row.last_usage <= row.updated <= now
            or not Decimal(row.amount).is_finite() or not 0 <= Decimal(row.amount) < 10**18):
        raise ValueError("No usable USD billing total was reported for this project and month.")
    rpc("mannsathi_ai_import_billing", {"p_project":project,"p_month":month.date().isoformat(),
        "p_amount":str(row.amount),"p_through":stamp(row.updated)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quota", nargs=2, action="append", metavar=("METRIC_BASE","GOOGLE_LIMIT_NAME"))
    parser.add_argument("--billing-table")
    parser.add_argument("--billing-location",help="BigQuery location of the export dataset")
    parser.add_argument("--max-query-bytes",type=int,default=1_073_741_824)
    args = parser.parse_args()
    project = os.environ.get("GEMINI_CLOUD_PROJECT","")
    if not PROJECT.fullmatch(project) or not (args.quota or args.billing_table) or args.max_query_bytes < 1:
        parser.error("Set GEMINI_CLOUD_PROJECT and select at least one quota or billing export.")
    import google.auth
    from google.auth.transport.requests import AuthorizedSession
    creds,_ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    model,now = configured_model(),datetime.now(UTC)
    failures = []
    with AuthorizedSession(creds) as session:
        for base,name in args.quota or []:
            try:
                complete = sync_quota(session,project,model,base,name,now)
                print(f"{name}: imported reported limit" + (" and observed usage." if complete else "; consumption unavailable."))
            except (KeyError,TypeError,ValueError,ApiError) as exc:
                failures.append(f"{name}: {exc}")
    if args.billing_table:
        try:
            sync_billing(creds,project,args.billing_table,args.billing_location,args.max_query_bytes,now)
            print("Imported the reported month-to-date billing total.")
        except (ValueError,ApiError) as exc:
            failures.append(str(exc))
    if failures:
        raise SystemExit("\n".join(failures))


if __name__ == "__main__":
    main()
