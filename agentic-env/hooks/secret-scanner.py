#!/usr/bin/env python3
"""
Secret Scanner Hook
Detects hardcoded secrets before git commits
"""

import json
import sys
import re
import subprocess
import os

SECRET_PATTERNS = [
    (r'AKIA[0-9A-Z]{16}', 'AWS Access Key ID', 'high'),
    (r'(?i)aws[_\-\s]*secret[_\-\s]*access[_\-\s]*key[\'"\s]*[=:][\'"\s]*[A-Za-z0-9/+=]{40}', 'AWS Secret Access Key', 'high'),
    (r'sk-ant-api\d{2}-[A-Za-z0-9\-_]{20,}', 'Anthropic API Key', 'high'),
    (r'sk-[a-zA-Z0-9]{48,}', 'OpenAI API Key', 'high'),
    (r'sk-proj-[a-zA-Z0-9\-_]{32,}', 'OpenAI Project API Key', 'high'),
    (r'AIza[0-9A-Za-z\-_]{35}', 'Google API Key', 'high'),
    (r'ya29\.[0-9A-Za-z\-_]+', 'Google OAuth Access Token', 'high'),
    (r'sk_live_[0-9a-zA-Z]{24,}', 'Stripe Live Secret Key', 'critical'),
    (r'sk_test_[0-9a-zA-Z]{24,}', 'Stripe Test Secret Key', 'medium'),
    (r'rk_live_[0-9a-zA-Z]{24,}', 'Stripe Live Restricted Key', 'high'),
    (r'pk_live_[0-9a-zA-Z]{24,}', 'Stripe Live Publishable Key', 'medium'),
    (r'ghp_[0-9a-zA-Z]{36}', 'GitHub Personal Access Token', 'high'),
    (r'gho_[0-9a-zA-Z]{36}', 'GitHub OAuth Token', 'high'),
    (r'ghs_[0-9a-zA-Z]{36}', 'GitHub App Secret', 'high'),
    (r'ghr_[0-9a-zA-Z]{36}', 'GitHub Refresh Token', 'high'),
    (r'github_pat_[0-9a-zA-Z_]{22,}', 'GitHub Fine-Grained PAT', 'high'),
    (r'glpat-[0-9a-zA-Z\-_]{20,}', 'GitLab Personal Access Token', 'high'),
    (r'vercel_[0-9a-zA-Z_\-]{24,}', 'Vercel Token', 'high'),
    (r'sbp_[0-9a-f]{40}', 'Supabase Service Key', 'high'),
    (r'hf_[a-zA-Z0-9]{34,}', 'Hugging Face Token', 'high'),
    (r'r8_[a-zA-Z0-9]{38,}', 'Replicate API Token', 'high'),
    (r'gsk_[a-zA-Z0-9]{48,}', 'Groq API Key', 'high'),
    (r'dapi[0-9a-f]{32}', 'Databricks Access Token', 'high'),
    (r'dop_v1_[0-9a-f]{64}', 'DigitalOcean Personal Access Token', 'high'),
    (r'lin_api_[a-zA-Z0-9]{40,}', 'Linear API Key', 'high'),
    (r'npm_[0-9a-zA-Z]{36,}', 'npm Access Token', 'high'),
    (r'pypi-[A-Za-z0-9\-_]{16,}', 'PyPI API Token', 'high'),
    (r'(?i)(api[_\-\s]*key|apikey)[\'"\s]*[=:][\'"\s]*[\'"][0-9a-zA-Z\-_]{20,}[\'"]', 'Generic API Key', 'medium'),
    (r'(?i)(secret[_\-\s]*key|secretkey)[\'"\s]*[=:][\'"\s]*[\'"][0-9a-zA-Z\-_]{20,}[\'"]', 'Generic Secret Key', 'medium'),
    (r'(?i)password[\'"\s]*[=:][\'"\s]*[\'"][^\'"\s]{8,}[\'"]', 'Hardcoded Password', 'high'),
    (r'-----BEGIN (RSA |DSA |EC )?PRIVATE KEY-----', 'Private Key', 'critical'),
    (r'-----BEGIN OPENSSH PRIVATE KEY-----', 'OpenSSH Private Key', 'critical'),
    (r'(?i)(mysql|postgresql|postgres|mongodb)://[^\s\'"\)]+:[^\s\'"\)]+@', 'Database Connection String', 'high'),
    (r'xox[baprs]-[0-9a-zA-Z\-]{10,}', 'Slack Token', 'high'),
    (r'SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}', 'SendGrid API Key', 'high'),
]

EXCLUDED_FILES = [
    '.env.example', '.env.sample', '.env.template',
    'package-lock.json', 'yarn.lock', 'poetry.lock',
    'Pipfile.lock', 'Cargo.lock', 'go.sum', '.gitignore',
]

EXCLUDED_DIRS = [
    'node_modules/', 'vendor/', '.git/', '.claude/', 'dist/', 'build/',
    '__pycache__/', '.pytest_cache/', 'venv/', 'env/',
]

TEST_FILE_PATTERNS = [
    r'test_.*\.py$',
    r'tests_.*\.py$',
    r'.*_test\.py$',
    r'.*_tests\.py$',
    r'.*_tests?_.*\.py$',
    r'.*tests?/.*\.py$',
    r'conftest\.py$',
    r'.*\.test\.(js|ts|jsx|tsx)$',
    r'.*\.spec\.(js|ts|jsx|tsx)$',
    r'.*__tests__.*',
]

def should_skip_file(file_path):
    if not os.path.exists(file_path):
        return True
    filename = os.path.basename(file_path)
    if filename in EXCLUDED_FILES:
        return True
    for excluded_dir in EXCLUDED_DIRS:
        if excluded_dir in file_path:
            return True
    normalized = file_path.replace('\\', '/')
    for pattern in TEST_FILE_PATTERNS:
        if re.search(pattern, normalized):
            return True
    try:
        with open(file_path, 'rb') as f:
            chunk = f.read(1024)
            if b'\0' in chunk:
                return True
    except:
        return True
    return False

def get_staged_files():
    try:
        result = subprocess.run(
            ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACM'],
            capture_output=True, text=True, check=True
        )
        return [f.strip() for f in result.stdout.split('\n') if f.strip()]
    except subprocess.CalledProcessError:
        return []

def scan_file(file_path):
    findings = []
    if should_skip_file(file_path):
        return findings
    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
        for line_num, line in enumerate(content.split('\n'), 1):
            for pattern, description, severity in SECRET_PATTERNS:
                matches = re.finditer(pattern, line)
                for match in matches:
                    line_stripped = line.strip()
                    if line_stripped.startswith('#') or line_stripped.startswith('//'):
                        if 'example' in line_stripped.lower() or 'placeholder' in line_stripped.lower():
                            continue
                    findings.append({
                        'file': file_path,
                        'line': line_num,
                        'description': description,
                        'severity': severity,
                        'match': match.group(0)[:50] + '...' if len(match.group(0)) > 50 else match.group(0),
                    })
    except Exception:
        pass
    return findings

def main():
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_input = input_data.get('tool_input', {})
    command = tool_input.get('command', '')
    if not re.search(r'git\s+commit', command):
        sys.exit(0)

    staged_files = get_staged_files()

    if not staged_files:
        commit_match = re.search(r'git\s+commit\s+(.+)', command)
        if commit_match and re.search(r'-\w*a', commit_match.group(1)):
            result = subprocess.run(['git', 'diff', '--name-only'], capture_output=True, text=True)
            for f in result.stdout.strip().split('\n'):
                if f.strip() and os.path.isfile(f.strip()):
                    staged_files.append(f.strip())

        for part in re.split(r'&&|;', command):
            part = part.strip()
            add_match = re.match(r'git\s+add\s+(.+)', part)
            if add_match:
                args = add_match.group(1).strip()
                if args in ('.', '-A', '--all'):
                    result = subprocess.run(['git', 'status', '--porcelain'], capture_output=True, text=True)
                    for line in result.stdout.strip().split('\n'):
                        if line and len(line) > 3:
                            f = line[3:].strip()
                            if os.path.isfile(f):
                                staged_files.append(f)
                else:
                    for token in args.split():
                        if not token.startswith('-') and os.path.isfile(token):
                            staged_files.append(token)

    if not staged_files:
        sys.exit(0)

    all_findings = []
    for file_path in staged_files:
        all_findings.extend(scan_file(file_path))

    if all_findings:
        severity_order = {'critical': 0, 'high': 1, 'medium': 2, 'low': 3}
        all_findings.sort(key=lambda x: severity_order.get(x['severity'], 4))

        print('', file=sys.stderr)
        print('🚨 SECRET SCANNER: possible secrets detected!', file=sys.stderr)
        print(f'Total: {len(all_findings)} finding(s)', file=sys.stderr)
        print('', file=sys.stderr)
        for f in all_findings:
            emoji = {'critical': '🔴', 'high': '🟠', 'medium': '🟡', 'low': '🔵'}.get(f['severity'], '⚪')
            print(f'{emoji} {f["description"]} — {f["file"]}:{f["line"]}', file=sys.stderr)
        print('', file=sys.stderr)
        print('❌ COMMIT BLOCKED: move the secrets to environment variables (.env)', file=sys.stderr)
        sys.exit(2)

    sys.exit(0)

if __name__ == '__main__':
    main()
