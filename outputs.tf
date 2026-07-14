output "vpc_id" {
  value = aws_vpc.main.id
}

output "alb_dns_name" {
  value = aws_lb.app_alb.dns_name
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.cdn.domain_name
}

output "cloudfront_distribution_id" {
  # GitHub Actions 의 CLOUDFRONT_DIST_ID 변수에 넣을 값 (캐시 무효화용)
  value = aws_cloudfront_distribution.cdn.id
}

output "static_bucket_name" {
  value = aws_s3_bucket.static_assets.id
}

# ===== GitHub Secrets 에 넣을 값 =====
# 조회: terraform output -raw github_actions_access_key_id
#       terraform output -raw github_actions_secret_access_key
output "github_actions_access_key_id" {
  value = aws_iam_access_key.github_actions.id
}

output "github_actions_secret_access_key" {
  value     = aws_iam_access_key.github_actions.secret
  sensitive = true
}

output "rds_endpoint" {
  value = aws_db_instance.postgresql.endpoint
}

output "route53_zone_id" {
  value = aws_route53_zone.main.zone_id
}
