"""Prompt-injection guard (a port of src/guard.ts, generated from its regular expressions).

Claims are rendered into other models' prompts, so text that tries to give those models instructions must not
travel silently. Pattern-based: it catches common attacks, not all.
"""

import re

_FLAGS = re.IGNORECASE | re.ASCII

PATTERNS = [
    (re.compile("\\b(ignore|disregard|forget|override|bypass)\\s+(?:\\w+\\s+){0,3}?(previous|prior|above|earlier|preceding|original|initial|all|any|your|safety|these|those)\\s+(?:\\w+\\s+){0,2}?(instructions?|prompts?|rules|guidelines|directives|directions|guidance|training|policies|filters|constraints)\\b", _FLAGS), "asks to ignore instructions", "high"),
    (re.compile("\\b(ignore|disregard|forget)\\s+(everything|anything)\\s+(above|before|you (were|have been) told)\\b", _FLAGS), "asks to ignore instructions", "high"),
    (re.compile("\\bignore\\b[^.\\n]{0,40}\\binstead,?\\s+(reply|respond|answer|say|output|print)\\b", _FLAGS), "asks to ignore instructions", "high"),
    (re.compile("\\b(new|updated|real|actual)\\s+(instructions?|rules|task|goal)\\s*:|\\byour\\s+(new|real|actual|true)\\s+(task|goal|instructions?|purpose)\\b", _FLAGS), "replaces the model's task", "high"),
    (re.compile("\\bnew system prompt\\b|\\bsystem override\\b|\\b(supersedes?|replaces?|overrides?)\\b[^.\\n]{0,20}\\b(previous|prior|earlier)\\s+(ones|instructions?|prompts?|rules)\\b", _FLAGS), "replaces the model's task", "high"),
    (re.compile("\\byour\\s+(instructions|rules|prompt|guidelines)\\s+(have|has)\\s+(been\\s+)?(changed|updated|replaced|revoked)\\b", _FLAGS), "replaces the model's task", "high"),
    (re.compile("<\\/?(system|assistant|user|instructions?)>|\\[\\/?INST\\]|<<\\/?SYS>>|<\\|[a-z_]+\\|>|###\\s*(instruction|response|system)\\s*:|\\[(system|assistant|user)\\]\\(#", _FLAGS), "contains chat-template markers", "high"),
    (re.compile("\\b(if you are|as)\\s+an?\\s+(?:ai|llms?|language models?|assistants?|chatbots?|copilot|chatgpt|claude|gemini|models?)\\b[^.\\n]{0,40}\\b(reading|processing|summari[sz]ing|parsing)\\b|\\b(?:ai|llms?|language models?|assistants?|chatbots?|copilot|chatgpt|claude|gemini|models?)\\s+(reading|processing|summari[sz]ing|parsing)\\s+this\\b", _FLAGS), "addresses a model that reads this text", "high"),
    (re.compile("\\b(note|message|instructions?|attention|hidden instructions?)\\s+(to|for)\\s+(the\\s+)?(\\w+\\s+)?(?:ai|llms?|language models?|assistants?|chatbots?|copilot|chatgpt|claude|gemini|models?)\\b", _FLAGS), "addresses a model that reads this text", "high"),
    (re.compile("\\b(hidden|secret)\\s+(instructions?|prompt)\\s+(for|to)\\b", _FLAGS), "addresses a model that reads this text", "high"),
    (re.compile("\\b(do not|don't|never)\\s+(tell|inform|reveal to|show)\\s+(the\\s+)?user\\b|\\b(do not|don't|never)\\s+(mention|reveal|disclose)\\b[^.\\n]{0,30}\\bto the user\\b|\\bwithout (telling|informing|notifying) the user\\b", _FLAGS), "asks to hide information from the user", "high"),
    (re.compile("\\byou are now\\b|\\bfrom now on,? you\\b|\\bpretend (to be|you are)\\b|\\bact as an?\\s+(unrestricted|unfiltered|uncensored|jailbroken|evil)\\b", _FLAGS), "tries to change the model's role", "high"),
    (re.compile("\\b(developer|maintenance|god|jailbreak|dan)\\s+mode\\s+(is\\s+)?(enabled|activated|on)\\b|\\b(without|no|disabled?)\\s+(any\\s+)?(content filters?|ethical guidelines|safety (rules|filters|guidelines))\\b", _FLAGS), "tries to change the model's role", "high"),
    (re.compile("\\b(print|reveal|output|repeat|show|leak|dump)\\b[^.\\n]{0,30}\\b(system prompt|initial prompt|hidden (context|instructions?|prompt)|developer message|your (instructions|prompt)|words above)\\b", _FLAGS), "asks to leak the prompt", "high"),
    (re.compile("^(?=[\\s\\S]*\\b(send|post|upload|exfiltrate|leak|forward|append|embed|include|replace)\\b)(?=[\\s\\S]*\\b(?:api[ _-]?keys?|tokens?|secrets?|passwords?|credentials?|cookies?|\\.env|env(?:ironment)? var(?:iable)?s?|conversation|chat history|email address(?:es)?|ssh keys?))(?=[\\s\\S]*https?:\\/\\/)", _FLAGS), "sends private data to a URL", "high"),
    (re.compile("\\b(system|developer) (prompt|message|instructions?)\\b", _FLAGS), "mentions system or developer prompts", "low"),
    (re.compile("\\b(new|updated|real|actual) instructions?\\b", _FLAGS), "announces new instructions", "low"),
    (re.compile("\\b(run|execute|eval)\\b[^.\\n]{0,30}\\b(curl|wget|bash|sh|powershell|rm -rf|base64)\\b", _FLAGS), "mentions running shell commands", "low"),
    (re.compile("\\b(send|post|upload|exfiltrate|leak|share|forward)\\b[^.\\n]{0,40}\\b(?:api[ _-]?keys?|tokens?|secrets?|passwords?|credentials?|cookies?|\\.env|env(?:ironment)? var(?:iable)?s?|conversation|chat history|email address(?:es)?|ssh keys?)", _FLAGS), "mentions sending secrets", "low"),
    (re.compile("\\b(always|must)\\b[^.\\n]{0,30}\\b(respond|reply|answer)\\b[^.\\n]{0,20}\\b(with|that)\\b|\\b(respond|reply|answer)\\b[^.\\n]{0,40}\\b(every|all)\\s+(future\\s+)?(questions?|messages?|requests?)\\b", _FLAGS), "dictates how a model must answer", "low"),
]

SUSPECT_TAG = "suspect"


def injection_findings(text):
    """Ways the text looks like an instruction aimed at a model: [{"reason", "severity"}]; empty for plain content."""
    return [{"reason": reason, "severity": severity} for rx, reason, severity in PATTERNS if rx.search(text)]


def is_high_risk(text):
    return any(f["severity"] == "high" for f in injection_findings(text))
