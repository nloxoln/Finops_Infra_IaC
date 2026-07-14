resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  default_root_object = "index.html"

  origin {
    domain_name = aws_lb.app_alb.dns_name
    origin_id   = "alb-origin"

    custom_origin_config {
      http_port              = 80
      https_port              = 443
      origin_protocol_policy   = "http-only" # ALB 리스너가 HTTP만 열려있으므로. HTTPS 붙이면 "https-only"로 변경
      origin_ssl_protocols     = ["TLSv1.2"]
    }
  }

  # 정적 프론트 리소스(css/js) - S3 캐싱용
  origin {
    domain_name              = aws_s3_bucket.static_assets.bucket_regional_domain_name
    origin_id                = "static-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.static_oac.id
  }

  # 상품 이미지를 S3로 이전할 경우 사용 (현재 DB의 thumbnail_url이 절대주소라 미사용 상태)
  origin {
    domain_name              = aws_s3_bucket.product_images.bucket_regional_domain_name
    origin_id                = "images-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.images_oac.id
  }

  # ---- 기본(*) : ALB (html 페이지) - 캐싱 끔 (배포 즉시 반영 + 로그인 상태) ----
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods          = ["GET", "HEAD"]
    target_origin_id        = "alb-origin"
    viewer_protocol_policy   = "redirect-to-https"
    compress                 = true

    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
  }

  # ---- /css/* : 정적 CSS (S3) - 캐싱 켬 ----
  ordered_cache_behavior {
    path_pattern           = "/css/*"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "static-origin"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  }

  # ---- /js/* : 정적 JS (S3) - 캐싱 켬 ----
  ordered_cache_behavior {
    path_pattern           = "/js/*"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "static-origin"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  }

  # ---- /api/* : 캐싱 끔, 전체 메서드 허용, 쿠키/헤더 전체 전달(Host 제외) ----
  ordered_cache_behavior {
    path_pattern             = "/api/*"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods            = ["GET", "HEAD"]
    target_origin_id          = "alb-origin"
    viewer_protocol_policy     = "redirect-to-https"

    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader (쿠키·헤더·쿼리 전달, Host만 제외)
  }

  # ---- /health : ALB 헬스체크용, 캐싱 끔 ----
  ordered_cache_behavior {
    path_pattern            = "/health"
    allowed_methods         = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    target_origin_id         = "alb-origin"
    viewer_protocol_policy    = "redirect-to-https"

    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
  }

  # ---- /images/* : 상품 이미지 S3 - 캐싱 켬 (추후 S3 URL 전환 시 사용) ----
  ordered_cache_behavior {
    path_pattern            = "/products/*"
    allowed_methods         = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    target_origin_id         = "images-origin"
    viewer_protocol_policy    = "redirect-to-https"
    compress                  = true

    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  }

  # 커스텀 도메인
  aliases = [var.domain_name]

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # ACM 인증서로 HTTPS 제공 (인증서는 us-east-1, acm.tf 참조)
  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cdn_cert.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name      = "app-cdn"
    component = "cloudfront"
  }

  logging_config {
    include_cookies = false
    bucket          = data.aws_s3_bucket.cf_logs.bucket_domain_name
    prefix          = "cloudfront/"
  }
}