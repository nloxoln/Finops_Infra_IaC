"""
finops-cost-event-alerter
=========================
CloudTrail(EventBridge 경유)로 들어온 '비용을 추가로 발생시킬 수 있는' API 호출을
감지해 기존 finops slack-notifier(API Gateway)로 알림을 보낸다.

이벤트를 생성/변경 두 종류로 분류한다:
  - CREATE (리소스 생성 감지)      -> 초록
  - MODIFY (리소스 사양 변경 감지) -> 보라

환경변수:
  SLACK_API_ENDPOINT  slack-notifier(API Gateway) URL. 비우면 전송 생략(로그만).
  COMPANY_NAME        회사명 (기본 "올리브영")
"""

import json
import os
import datetime
import urllib.request
import urllib.error

SLACK_API_ENDPOINT = os.environ.get("SLACK_API_ENDPOINT", "").strip()
COMPANY_NAME = os.environ.get("COMPANY_NAME", "올리브영").strip()

# eventName -> (서비스 키, 종류: CREATE | MODIFY)
COST_EVENTS = {
    # ---- EC2 : 생성 계열 ----
    "RunInstances": ("ec2", "CREATE"),
    "StartInstances": ("ec2", "CREATE"),
    "CreateNatGateway": ("ec2", "CREATE"),
    "AllocateAddress": ("ec2", "CREATE"),
    "CreateFleet": ("ec2", "CREATE"),
    "RequestSpotFleet": ("ec2", "CREATE"),
    "CreateVolume": ("ec2", "CREATE"),
    "PurchaseReservedInstancesOffering": ("ec2", "CREATE"),
    # ---- EC2 : 변경 계열 ----
    "ModifyInstanceAttribute": ("ec2", "MODIFY"),
    # ---- RDS : 생성 ----
    "CreateDBInstance": ("rds", "CREATE"),
    "CreateDBCluster": ("rds", "CREATE"),
    "CreateDBInstanceReadReplica": ("rds", "CREATE"),
    "PurchaseReservedDBInstancesOffering": ("rds", "CREATE"),
    # ---- RDS : 변경 ----
    "ModifyDBInstance": ("rds", "MODIFY"),
    "ModifyDBCluster": ("rds", "MODIFY"),
    # ---- DynamoDB ----
    "CreateTable": ("dynamodb", "CREATE"),
    "UpdateTable": ("dynamodb", "MODIFY"),
    # ---- ElastiCache ----
    "CreateCacheCluster": ("elasticache", "CREATE"),
    "CreateReplicationGroup": ("elasticache", "CREATE"),
    "ModifyCacheCluster": ("elasticache", "MODIFY"),
    # ---- Redshift ----
    "ResizeCluster": ("redshift", "MODIFY"),
    "ModifyCluster": ("redshift", "MODIFY"),
    # ---- SageMaker ----
    "CreateEndpoint": ("sagemaker", "CREATE"),
    "CreateNotebookInstance": ("sagemaker", "CREATE"),
    "UpdateEndpoint": ("sagemaker", "MODIFY"),
    "UpdateEndpointWeightsAndCapacities": ("sagemaker", "MODIFY"),
    # ---- Auto Scaling ----
    "UpdateAutoScalingGroup": ("autoscaling", "MODIFY"),
    "SetDesiredCapacity": ("autoscaling", "MODIFY"),
    "RegisterScalableTarget": ("application-autoscaling", "CREATE"),
    # ---- Kinesis ----
    "CreateStream": ("kinesis", "CREATE"),
    "UpdateShardCount": ("kinesis", "MODIFY"),
    # ---- Lambda ----
    "PutProvisionedConcurrencyConfig": ("lambda", "MODIFY"),
    # ---- OpenSearch ----
    "CreateDomain": ("opensearch", "CREATE"),
    "UpdateDomainConfig": ("opensearch", "MODIFY"),
    # ---- 컨테이너 / 빅데이터 ----
    "CreateNodegroup": ("eks", "CREATE"),
    "RunJobFlow": ("emr", "CREATE"),
    "CreateCluster": ("cluster", "CREATE"),
    # ---- Bedrock ----
    "CreateProvisionedModelThroughput": ("bedrock", "CREATE"),
}

KIND_TITLE = {
    "CREATE": "리소스 생성 감지",
    "MODIFY": "리소스 사양 변경 감지",
}


def actor_of(user_identity):
    """CloudTrail userIdentity 에서 실제 실행 주체를 뽑는다."""
    if not user_identity:
        return "알 수 없음"
    ctx = user_identity.get("sessionContext", {})
    issuer = ctx.get("sessionIssuer", {})
    principal = user_identity.get("principalId", "")
    if issuer.get("userName"):
        # SSO/역할: principalId 뒤쪽에 실제 세션명(사람)이 붙는 경우가 많음
        tail = principal.split(":")[-1] if ":" in principal else ""
        who = issuer["userName"] + (f" / {tail}" if tail else "")
        return f"{issuer.get('type', 'Role')}:{who}"
    if user_identity.get("userName"):
        return f"IAMUser:{user_identity['userName']}"
    if user_identity.get("type") == "Root":
        return "Root(루트 계정)"
    for key in ("arn", "principalId", "accountId"):
        if user_identity.get(key):
            return str(user_identity[key])
    return user_identity.get("type", "알 수 없음")


def build_payload(detail, service, kind):
    region = detail.get("awsRegion", "-")
    actor = actor_of(detail.get("userIdentity", {}))
    src_ip = detail.get("sourceIPAddress", "-")
    event_name = detail.get("eventName", "-")
    when = detail.get("eventTime") or datetime.datetime.utcnow().isoformat() + "Z"
    title = KIND_TITLE.get(kind, "리소스 변동 감지")

    summary = f"{actor} 이(가) {region}에서 `{event_name}` 실행"
    raw_data = f"{event_name} by {actor} @ {region} ({src_ip})"

    cause = (
        "비용을 추가로 발생시킬 수 있는 API 호출이 감지됨.\n"
        f"\u2022 호출자: {actor}\n"
        f"\u2022 리전: {region}  \u2022 Source IP: {src_ip}\n\n"
        f"\u25b6 콘솔 확인: CloudTrail \u2192 이벤트 기록에서 `{event_name}` 검색 / 해당 리소스 콘솔에서 사양\u00b7요금 확인"
    )

    return {
        "company": COMPANY_NAME,
        "severity": kind,            # CREATE=초록, MODIFY=보라
        "title": title,             # 커스텀 제목
        "service": service,
        "summary": summary,
        "cause": cause,
        "rawData": raw_data,
        "detectedAt": when,         # 탐지 시각 유지
        "hideActionRequired": True,  # '조치 필요' 필드 숨김
        "source": "cloudtrail-event-alerter",
    }


def send(payload):
    if not SLACK_API_ENDPOINT:
        print("SLACK_API_ENDPOINT 미설정 - 전송 생략. payload=",
              json.dumps(payload, ensure_ascii=False)[:600])
        return
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        SLACK_API_ENDPOINT, data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            print("slack-notifier 응답:", resp.status)
    except urllib.error.HTTPError as e:
        print("slack-notifier HTTP 오류:", e.code, e.read().decode("utf-8", "ignore"))
    except Exception as e:
        print("전송 실패:", repr(e))


def lambda_handler(event, context):
    detail = event.get("detail", event)
    event_name = detail.get("eventName")

    if not event_name or event_name not in COST_EVENTS:
        print(f"관심 대상 아님, 스킵: {event_name}")
        return {"skipped": True, "eventName": event_name}

    if detail.get("errorCode") or detail.get("errorMessage"):
        print(f"실패한 호출이라 스킵: {event_name} / {detail.get('errorCode')}")
        return {"skipped": True, "reason": "errored"}

    service, kind = COST_EVENTS[event_name]
    payload = build_payload(detail, service, kind)
    send(payload)
    return {"notified": True, "eventName": event_name, "kind": kind}