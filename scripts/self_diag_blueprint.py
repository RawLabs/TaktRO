#!/usr/bin/env python3
import os
import sys
import ast
import json
import re
import urllib.request
from pathlib import Path

# --- CONFIGURATION ---
LOCAL_LLM_URL = os.environ.get("LM_STUDIO_URL", "http://localhost:1234/v1/chat/completions")
EXCERPT_LINE_BUDGET = 250  # Max context lines to include in capsule

class ASTIndexer(ast.NodeVisitor):
    """Deterministic AST parser to extract function and class symbols."""
    def __init__(self, filepath: Path):
        self.filepath = filepath
        self.symbols = []

    def visit_FunctionDef(self, node):
        self.symbols.append({
            "name": node.name,
            "line_start": node.lineno,
            "line_end": getattr(node, "end_lineno", node.lineno + 10)
        })
        self.generic_visit(node)

def scan_repository(root_dir: Path) -> dict:
    """Deterministic indexer for Python source files."""
    repo_index = {}
    for path in root_dir.rglob("*.py"):
        if any(part.startswith(".") or part == "venv" for part in path.parts):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            
            # Extract AST symbols
            tree = ast.parse(content)
            indexer = ASTIndexer(path)
            indexer.visit(tree)
            
            repo_index[str(path.relative_to(root_dir))] = {
                "content": content,
                "symbols": indexer.symbols
            }
        except Exception:
            continue
    return repo_index

def rank_and_extract_excerpts(symptom: str, repo_index: dict) -> list[dict]:
    """Simple term-matching to extract relevant code context (Haystack Shrinking)."""
    symptom_words = set(re.findall(r"\w+", symptom.lower()))
    matches = []
    
    for rel_path, data in repo_index.items():
        score = 0
        content_lower = data["content"].lower()
        
        # Simple frequency scoring
        for word in symptom_words:
            if len(word) > 3:  # Skip common short words
                score += content_lower.count(word)
        
        if score > 0:
            matches.append((rel_path, score, data))
            
    # Sort by relevance score
    matches.sort(key=lambda x: x[1], reverse=True)
    
    excerpts = []
    
    for rel_path, score, data in matches[:2]:  # Top 2 files
        lines = data["content"].splitlines()
        excerpt_lines = lines[:EXCERPT_LINE_BUDGET]
        
        excerpts.append({
            "path": rel_path,
            "start_line": 1,
            "end_line": len(excerpt_lines),
            "content": "\n".join(excerpt_lines)
        })
    return excerpts

def query_local_semantic_router(symptom: str, excerpts: list[dict]) -> dict:
    """Queries local AI on port 1234 to pinpoint the target file and function."""
    snippet_parts = []
    for ex in excerpts:
        snippet_parts.append(f"File: {ex['path']} (L{ex['start_line']}-L{ex['end_line']})\n{ex['content']}")
    combined_excerpts = "\n\n".join(snippet_parts)

    prompt = (
        f"HUMAN REPORTED SYMPTOM:\n{symptom}\n\n"
        f"TARGET SOURCE CODE EXCERPTS:\n{combined_excerpts}\n\n"
        "INSTRUCTION: Analyze the symptom against the source excerpts. Respond in JSON format with:\n"
        "{\n"
        '  "confidence": 0.90,\n'
        '  "target_file": "path/file.py",\n'
        '  "target_symbol": "function_name",\n'
        '  "hypothesis": "Concise 2-sentence explanation of defect"\n'
        "}\n"
        "If evidence is insufficient, set confidence < 0.5 and target_file/target_symbol to null."
    )

    payload = {
        "messages": [
            {"role": "system", "content": "You are a local semantic routing agent. Output strict JSON only matching the schema."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.1,
        "max_tokens": 200
    }

    try:
        req = urllib.request.Request(
            LOCAL_LLM_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            res_data = json.loads(resp.read().decode("utf-8"))
            content = res_data.get("choices", [{}])[0].get("message", {}).get("content", "")
            
            # Clean markdown code fences if outputted
            clean_content = re.sub(r"^```json\s*", "", content.strip())
            clean_content = re.sub(r"\s*```$", "", clean_content)
            return json.loads(clean_content)
    except Exception as e:
        return {"error": f"Local AI offline or error: {str(e)}", "confidence": 0.0}

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 self_diag_blueprint.py '<symptom description>'")
        sys.exit(1)
        
    symptom = sys.argv[1]
    root = Path(__file__).resolve().parent.parent
    
    print("1. Indexing repository (Haystack Shrinking)...")
    repo_index = scan_repository(root)
    
    print("2. Extracting context snippets...")
    excerpts = rank_and_extract_excerpts(symptom, repo_index)
    
    print("3. Querying local semantic router (Qwen3-Coder)...")
    routing_result = query_local_semantic_router(symptom, excerpts)
    
    # Print target prediction
    print("\n==========================================")
    print("          SEMANIC ROUTING RESULTS         ")
    print("==========================================")
    print(f"Target File:   {routing_result.get('target_file')}")
    print(f"Target Symbol: {routing_result.get('target_symbol')}")
    print(f"Confidence:    {routing_result.get('confidence')}")
    print(f"Hypothesis:    {routing_result.get('hypothesis')}")
    print("==========================================\n")

if __name__ == "__main__":
    main()
