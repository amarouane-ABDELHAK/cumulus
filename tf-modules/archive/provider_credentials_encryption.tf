resource "aws_kms_key" "provider_kms_key" {
  description = "${var.prefix} Provider credentials encryption"
  tags        = local.default_tags
}

data "aws_iam_policy_document" "provider_secrets_encryption" {
  statement {
    actions   = [
      "kms:Encrypt",
      "kms:Decrypt"
    ]
    resources = [aws_kms_key.provider_kms_key.arn]
  }
}

resource "aws_iam_role_policy" "provider_secrets_encryption" {
  role   = aws_iam_role.lambda_api_gateway.id
  policy = data.aws_iam_policy_document.provider_secrets_encryption.json
}

resource "aws_lambda_function" "provider_secrets_migration" {
  function_name    = "${var.prefix}-ProviderSecretsMigration"
  filename         = "${path.module}/../../packages/api/dist/providerSecretsMigration/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../packages/api/dist/providerSecretsMigration/lambda.zip")
  handler          = "index.handler"
  role             = aws_iam_role.lambda_api_gateway.arn
  runtime          = "nodejs10.x"
  timeout          = 100
  environment {
    variables = {
      stackName           = var.prefix
      system_bucket       = var.system_bucket
      provider_kms_key_id = aws_kms_key.provider_kms_key.key_id
      ProvidersTable      = var.dynamo_tables.providers.name
    }
  }
  memory_size = 256
  tags        = merge(local.default_tags, { Project = var.prefix })

  vpc_config {
    subnet_ids         = var.lambda_subnet_ids
    security_group_ids = var.lambda_subnet_ids == null ? null : [aws_security_group.no_ingress_all_egress[0].id, var.elasticsearch_security_group_id]
  }
}

resource "aws_lambda_function" "verify_provider_secrets_migration" {
  function_name    = "${var.prefix}-VerifyProviderSecretsMigration"
  filename         = "${path.module}/../../packages/api/dist/verifyProviderSecretsMigration/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../packages/api/dist/verifyProviderSecretsMigration/lambda.zip")
  handler          = "index.handler"
  role             = aws_iam_role.lambda_api_gateway.arn
  runtime          = "nodejs10.x"
  timeout          = 100
  environment {
    variables = {
      provider_kms_key_id = aws_kms_key.provider_kms_key.key_id
      ProvidersTable      = var.dynamo_tables.providers.name
    }
  }
  memory_size = 256
  tags        = merge(local.default_tags, { Project = var.prefix })

  vpc_config {
    subnet_ids         = var.lambda_subnet_ids
    security_group_ids = var.lambda_subnet_ids == null ? null : [aws_security_group.no_ingress_all_egress[0].id, var.elasticsearch_security_group_id]
  }
}
