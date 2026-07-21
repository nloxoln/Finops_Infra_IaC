# ---- CodeDeploy 배포, 깃헙에서 코드를 zip으로 저장시킨다.  ----
resource "aws_s3_bucket" "codedeploy_bundles" {
  bucket        = var.codedeploy_bucket_name
  force_destroy = true # 배포 zip 이라 destroy 할때 같이 지워져도 상관없심!

  tags = {
    Name      = "codedeploy-bundles"
    component = "s3-codedeploy"
  }
}

# ---- 정적 프론트 리소스(css/js) 캐싱용 ----
resource "aws_s3_bucket" "static_assets" {
  bucket = var.s3_static_bucket_name
  force_destroy = true

  tags = {
    Name      = "static-assets"
    component = "s3-static"
  }
}

resource "aws_cloudfront_origin_access_control" "static_oac" {
  name                              = "static-assets-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "static_assets" {
  bucket = aws_s3_bucket.static_assets.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.static_assets.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.cdn.arn
          }
        }
      }
    ]
  })
}

# ---- 상품 이미지 저장용, 디비에는 클라우드 프론트 url로 해둠 ----
resource "aws_s3_bucket" "product_images" {
  bucket = var.s3_images_bucket_name
  force_destroy = true

  # terraform destroy 로도 이 버킷은 삭제되지 않게 보호 (업로드한 이미지 보존)
  #lifecycle {
  #  prevent_destroy = true
  #}

  tags = {
    Name      = "product-images"
    component = "s3-images"
  }
}

resource "aws_cloudfront_origin_access_control" "images_oac" {
  name                              = "product-images-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "product_images" {
  bucket = aws_s3_bucket.product_images.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.product_images.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.cdn.arn
          }
        }
      }
    ]
  })
}
