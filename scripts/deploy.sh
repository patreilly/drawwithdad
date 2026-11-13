#!/usr/bin/env bash
# Builds Draw with Dad and deploys it to AWS (deploy/cloudformation.yaml):
#   - the app: private S3 bucket behind CloudFront
#   - the API: Lambda + API Gateway (HTTP API) under /api on the same CloudFront domain
#   - the data: one DynamoDB table (on-demand, point-in-time recovery, kept if the stack is deleted)
# The first run creates everything (~5 min, mostly CloudFront); later runs take about a minute.
#
#   npm run deploy:aws
#
# Options (environment variables):
#   STACK=draw-with-dad         CloudFormation stack name, so you can run several copies
#   AWS_PROFILE / AWS_REGION    which AWS account and region to use
#   MAIL_FROM=you@example.com   send password-reset emails through Amazon SES (verify the address in SES first)
#   APP_URL=https://draw.example.com   public URL for email links, if you put a custom domain in front
#   PRICE_CLASS=PriceClass_100  CloudFront edge locations (100 = US/EU, cheapest)
set -euo pipefail

STACK="${STACK:-draw-with-dad}"
PRICE_CLASS="${PRICE_CLASS:-PriceClass_100}"
cd "$(dirname "$0")/.."

die() { echo "✖ $*" >&2; exit 1; }

command -v npm >/dev/null || die "Node.js is required (https://nodejs.org, version 22 or newer)."
command -v zip >/dev/null || die "The 'zip' command is required (macOS has it; on Linux: apt install zip)."
aws --version >/dev/null 2>&1 || die "The AWS CLI isn't installed or doesn't run on this machine.
  Install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html  (macOS: brew install awscli)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "The AWS CLI has no working credentials. Run 'aws configure' (or 'aws sso login'), then try again."
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
[[ -n "$REGION" ]] || die "No AWS region set. Run 'aws configure set region us-east-1' (or set AWS_REGION)."
export AWS_REGION="$REGION"

echo "▶ Deploying stack '$STACK' to account $ACCOUNT in $REGION"

echo "▶ Building and testing"
npm ci --no-audit --no-fund
npm test
npm run build

# The Lambda code needs a bucket before the stack can use it. This one is private and only holds zips.
ARTIFACTS="$(echo "$STACK-artifacts-$ACCOUNT-$REGION" | tr '[:upper:]' '[:lower:]' | cut -c1-63)"
if ! aws s3api head-bucket --bucket "$ARTIFACTS" 2>/dev/null; then
  echo "▶ Creating artifacts bucket $ARTIFACTS"
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$ARTIFACTS" >/dev/null
  else
    aws s3api create-bucket --bucket "$ARTIFACTS" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$ARTIFACTS" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

ZIP="$(mktemp -d)/api.zip"
(cd dist-server && zip -qr "$ZIP" .)
CODE_KEY="api/$(shasum -a 256 "$ZIP" | cut -c1-16).zip"
aws s3 cp "$ZIP" "s3://$ARTIFACTS/$CODE_KEY" --only-show-errors

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true
}

deploy_stack() {
  local overrides=("CodeBucket=$ARTIFACTS" "CodeKey=$CODE_KEY" "PriceClass=$PRICE_CLASS")
  [[ -n "${MAIL_FROM:-}" ]] && overrides+=("MailFrom=$MAIL_FROM")
  [[ -n "${1:-}" ]] && overrides+=("AppUrl=$1")
  aws cloudformation deploy \
    --stack-name "$STACK" \
    --template-file deploy/cloudformation.yaml \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides "${overrides[@]}" \
    --no-fail-on-empty-changeset
}

echo "▶ Creating/updating infrastructure (the first time takes ~5 minutes)"
deploy_stack "${APP_URL:-}"

URL="$(output Url)"
CURRENT_APP_URL="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Parameters[?ParameterKey=='AppUrl'].ParameterValue" --output text)"
WANT_APP_URL="${APP_URL:-$URL}"
if [[ "$CURRENT_APP_URL" != "$WANT_APP_URL" ]]; then
  # The CloudFront URL only exists after the first deploy; tell the API about it for email links.
  echo "▶ Setting the app URL for emails to $WANT_APP_URL"
  deploy_stack "$WANT_APP_URL"
fi

BUCKET="$(output BucketName)"
DIST="$(output DistributionId)"

echo "▶ Uploading the app to s3://$BUCKET"
# Hashed assets never change. Old ones are kept so tabs opened before this deploy keep working.
aws s3 sync dist/assets "s3://$BUCKET/assets" --cache-control "public,max-age=31536000,immutable" --only-show-errors
# index.html goes last, so it never points at assets that aren't uploaded yet.
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --cache-control "no-cache" --only-show-errors
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/" "/index.html" >/dev/null

echo "✔ Deployed: $URL"
echo "  (A brand-new CloudFront URL can take a few minutes to start answering.)"
[[ -n "${MAIL_FROM:-}" ]] || echo "  Password-reset emails aren't being sent yet: run again with MAIL_FROM=you@example.com (see README)."
