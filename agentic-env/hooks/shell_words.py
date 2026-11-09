"""Shared shell parsing for the Bash hooks: split a command into simple commands, each as its argv.

Hooks must judge what a command RUNS, not words that appear in it: "git push" inside a grep pattern,
an echo or a heredoc body is text, not a push. Used by account-guard and dangerous-command-blocker.
"""
import os
import re
import shlex

SEPARATORS = {';', '&&', '||', '|', '&', '|&', ';;'}
REDIRECTS = {'>', '>>', '<', '<<', '<<<', '>&', '<&', '&>', '>|'}
WRAPPERS = {'sudo', 'command', 'nohup', 'time', 'nice', 'env', 'xargs', 'exec'}
SHELLS = {'bash', 'sh', 'zsh'}
HEREDOC = re.compile(r'<<-?\s*([\'"]?)(\w+)\1')


def tokens(text):
    try:
        lex = shlex.shlex(text, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        return list(lex)
    except ValueError:  # unbalanced quotes: fall back to plain words
        return text.split()


def feeds_a_shell(line):
    """True when the heredoc on this line is read by a shell (`bash <<EOF`, `... | sh <<EOF`): its body runs."""
    before = line[:HEREDOC.search(line).start()]
    words = [os.path.basename(w) for w in re.split(r'[\s|;&()]+', before) if w]
    return any(w in SHELLS for w in words)


def code_lines(text):
    """The command's lines without the bodies of heredocs fed to ordinary programs (`cat`, `python3`,
    `git commit -F -`): that text is data. A heredoc read by a shell is code and is kept."""
    end = None
    for line in text.splitlines():
        if end is not None:
            if line.strip() == end:
                end = None
            continue
        m = HEREDOC.search(line)
        if m and not feeds_a_shell(line):
            end = m.group(2)
        yield line


def simple_commands(text):
    """Each simple command's argv, with redirection operators and their targets removed."""
    for line in code_lines(text):
        argv, skip = [], False
        for tok in tokens(line):
            if skip:
                skip = False
            elif tok in SEPARATORS:
                if argv:
                    yield argv
                argv = []
            elif tok in REDIRECTS or re.fullmatch(r'\d?[<>]{1,2}&?', tok):
                skip = True
            elif tok not in ('(', ')', '{', '}'):
                argv.append(tok)
        if argv:
            yield argv


def unwrap(argv):
    """Drop `sudo`, `env`, `VAR=value` and similar prefixes: the argv of the program that actually runs."""
    while argv and (argv[0] in WRAPPERS or re.fullmatch(r'\w+=.*', argv[0])):
        argv = argv[1:]
    return argv


def shell_script(argv):
    """The script of `bash -c "<script>"` (or sh / zsh), else None."""
    if argv and os.path.basename(argv[0]) in SHELLS and '-c' in argv:
        i = argv.index('-c') + 1
        return argv[i] if i < len(argv) else ''
    return None
