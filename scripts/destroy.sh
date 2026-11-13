#!/usr/bin/env bash
# Deletes what deploy.sh created: the app, the API and the CDN. The DynamoDB table with
# everyone's accounts is kept unless you also confirm deleting it.
#   npm run destroy:aws          (STACK=... to pick a different copy)
set -euo pipefail

STACK="${STACK:-draw-with-dad}"
die() { echo "✖ $*" >&2; exit 1; }
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "The AWS CLI isn't working or has no credentials. Run 'aws configure' first."
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
export AWS_REGION="$REGION"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET="$(output BucketName 2>/dev/null)" || die "No stack named '$STACK' in $REGION."
TABLE="$(output TableName)"
ARTIFACTS="$(echo "$STACK-artifacts-$ACCOUNT-$REGION" | tr '[:upper:]' '[:lower:]' | cut -c1-63)"

read -r -p "Delete the '$STACK' app, API and CDN? Type the stack name to confirm: " answer
[[ "$answer" == "$STACK" ]] || die "Cancelled."
read -r -p "Also delete ALL accounts, profiles and saved pictures (DynamoDB table $TABLE)? This can't be undone. [y/N] " data

aws s3 rm "s3://$BUCKET" --recursive --only-show-errors
aws cloudformation delete-stack --stack-name "$STACK"
echo "▶ Waiting for deletion (CloudFront takes a few minutes)…"
aws cloudformation wait stack-delete-complete --stack-name "$STACK"

if aws s3api head-bucket --bucket "$ARTIFACTS" 2>/dev/null; then
  aws s3 rb "s3://$ARTIFACTS" --force >/dev/null
fi

if [[ "$data" =~ ^[Yy]$ ]]; then
  aws dynamodb delete-table --table-name "$TABLE" >/dev/null
  echo "✔ Deleted everything, including user data."
else
  echo "✔ Deleted. User data is still in DynamoDB table '$TABLE' (deploying again won't reuse it automatically)."
fi
