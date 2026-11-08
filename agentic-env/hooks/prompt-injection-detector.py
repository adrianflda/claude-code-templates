#!/usr/bin/env python3
"""
Prompt Injection Detector Hook
Scans file content BEFORE Claude reads it, looking for injection attempts.
Runs on PreToolUse for Read, WebFetch, and Bash tool calls.
"""

import json
import sys
import re
import os

# Patterns that suggest prompt injection attempts
INJECTION_PATTERNS = [
    # Classic override attempts
    (r'(?i)ignore\s+(all\s+)?(previous|prior|above|your)\s+instructions?', 'Instruction override attempt'),
    (r'(?i)disregard\s+(all\s+)?(previous|prior|your)\s+instructions?', 'Attempt to disregard instructions'),
    (r'(?i)forget\s+(all\s+)?(previous|prior|your)\s+instructions?', 'Attempt to erase instructions'),

    # Role hijacking
    (r'(?i)you\s+are\s+now\s+(a\s+|an\s+)?(new\s+)?(AI|assistant|model|system|bot|claude)', 'Role change attempt'),
    (r'(?i)(new|updated)\s+(system\s+)?(prompt|instructions?|role|persona)', 'New system prompt injection'),
    (r'(?i)act\s+as\s+(if\s+you\s+are\s+)?(a\s+|an\s+)?(different|new|evil|unrestricted)', 'Persona change attempt'),

    # Privilege escalation
    (r'(?i)(admin|administrator|root|sudo|superuser)\s+(mode|access|override|privileges?)', 'Privilege escalation attempt'),
    (r'(?i)(developer|debug|maintenance|god|jailbreak)\s+mode', 'Special mode attempt'),
    (r'(?i)you\s+(now\s+)?(have|gained?)\s+(elevated|special|admin|full|unrestricted)\s+(access|permissions?|privileges?)', 'Elevated permissions attempt'),

    # Data exfiltration
    (r'(?i)(send|post|upload|exfiltrate|transmit)\s+.{0,30}(to\s+)?(https?://|curl|wget)', 'Data exfiltration attempt'),
    (r'(?i)curl\s+.{0,50}(api[_\-]?key|password|secret|token|credential)', 'Comando curl con datos sensibles'),

    # Fake system messages
    (r'(?i)\[SYSTEM\][\s\S]{0,20}(instruction|command|override|prompt)', 'Fake system message'),
    (r'(?i)<\s*system\s*>[\s\S]{0,100}<\s*/\s*system\s*>', 'Injected system tag'),
    (r'(?i)###\s*(SYSTEM|ADMIN|OVERRIDE|HIDDEN)\s*(PROMPT|INSTRUCTION|COMMAND)', 'Hidden instruction header'),

    # Safety bypass
    (r'(?i)(bypass|disable|ignore|skip)\s+(safety|security|filter|guardrail|restriction|limitation)', 'Safety bypass attempt'),
    (r'(?i)(without|no)\s+(restriction|limitation|filter|safety|guardrail)', 'Solicitud sin restricciones'),

    # Hidden instructions in HTML/markdown comments
    (r'<!--[\s\S]{0,500}(ignore|system|instruction|override|prompt|execute|run|delete|send)[\s\S]{0,200}-->', 'Hidden instruction in an HTML comment'),
]

# Files that are safe to skip (low risk)
SKIP_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
                   '.woff', '.woff2', '.ttf', '.eot',
                   '.zip', '.tar', '.gz', '.mp4', '.mp3']


def check_content(content, source):
    """Check content for injection patterns, return list of findings."""
    findings = []
    lines = content.split('\n')

    for pattern, description in INJECTION_PATTERNS:
        for line_num, line in enumerate(lines, 1):
            if re.search(pattern, line):
                findings.append({
                    'line': line_num,
                    'description': description,
                    'content': line.strip()[:120],
                    'source': source
                })
                break  # One finding per pattern per source is enough

    return findings


def main():
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = input_data.get('tool_name', '')
    tool_input = input_data.get('tool_input', {})

    content_to_check = None
    source_label = ''

    # For Read tool: check if file exists and scan it
    if tool_name == 'Read':
        file_path = tool_input.get('file_path', '')
        if not file_path or not os.path.exists(file_path):
            sys.exit(0)

        # Skip Claude's own config files (they legitimately document injection patterns)
        home = os.path.expanduser('~')
        claude_dir = os.path.join(home, '.claude')
        if os.path.abspath(file_path).startswith(os.path.abspath(claude_dir)):
            sys.exit(0)

        # Skip binary/media files
        _, ext = os.path.splitext(file_path.lower())
        if ext in SKIP_EXTENSIONS:
            sys.exit(0)

        # Only scan text-like files under 500KB
        try:
            if os.path.getsize(file_path) > 500_000:
                sys.exit(0)
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                content_to_check = f.read()
            source_label = f'archivo: {file_path}'
        except Exception:
            sys.exit(0)

    # For WebFetch: warn always (external content is untrusted)
    elif tool_name == 'WebFetch':
        url = tool_input.get('url', '')
        print('', file=sys.stderr)
        print('⚠️  WARNING: fetching external content', file=sys.stderr)
        print(f'   URL: {url}', file=sys.stderr)
        print('', file=sys.stderr)
        print('Web page content may contain prompt injection.', file=sys.stderr)
        print('The result will be treated as data, not as instructions.', file=sys.stderr)
        print('', file=sys.stderr)
        sys.exit(0)  # Allow but warned

    else:
        sys.exit(0)

    if not content_to_check:
        sys.exit(0)

    findings = check_content(content_to_check, source_label)

    if findings:
        print('', file=sys.stderr)
        print('🚨 PROMPT INJECTION DETECTED', file=sys.stderr)
        print(f'   Source: {source_label}', file=sys.stderr)
        print('', file=sys.stderr)
        for f in findings:
            print(f'   ⚠️  {f["description"]} (line {f["line"]})', file=sys.stderr)
            print(f'   Content: {f["content"][:80]}', file=sys.stderr)
            print('', file=sys.stderr)
        print('❌ BLOCKED: this file contains prompt-injection patterns.', file=sys.stderr)
        print('   Review the file by hand before continuing.', file=sys.stderr)
        print('   If this is a false positive, open the file yourself and tell Claude what to do.', file=sys.stderr)
        print('', file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == '__main__':
    main()
