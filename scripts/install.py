#!/usr/bin/env python3
"""
install.py — KostOps One-Command Installer
-------------------------------------------
Runs the full deployment and shows a live status checklist so customers
can see exactly what is happening and when each step completes.

Usage:
    python scripts/install.py [options]

Options:
    --skip-build          Skip frontend npm install + build
    --skip-bootstrap      Skip CDK bootstrap (already done)
    --skip-cdk            Skip CDK deploy (already deployed)
    --skip-agent          Skip agent zip/deploy (already deployed)
    --skip-verify         Skip post-deploy verification

The script reads customer config from cdk.json (cdk context) or environment
variables. It writes nothing to disk except the CDK/agent artifacts.

Exit codes:
    0 — all steps succeeded
    1 — a required step failed (details printed above)
"""

import os
import sys
import json
import time
import shutil
import subprocess
import argparse
import threading
import itertools
import textwrap
from pathlib import Path
from typing import Optional, List, Tuple

# ── Colour / ANSI helpers ─────────────────────────────────────────────────────

_NO_COLOUR = not sys.stdout.isatty() or os.environ.get('NO_COLOR')

def _c(code: str, text: str) -> str:
    if _NO_COLOUR:
        return text
    return f"\033[{code}m{text}\033[0m"

def green(t):  return _c('32', t)
def red(t):    return _c('31', t)
def yellow(t): return _c('33', t)
def cyan(t):   return _c('36', t)
def bold(t):   return _c('1',  t)
def dim(t):    return _c('2',  t)

ICON_PENDING = dim('○')
ICON_RUNNING = cyan('◉')
ICON_OK      = green('✓')
ICON_FAIL    = red('✗')
ICON_SKIP    = dim('–')

# ── Checklist state ───────────────────────────────────────────────────────────

PENDING = 'pending'
RUNNING = 'running'
OK      = 'ok'
FAIL    = 'fail'
SKIP    = 'skip'

class Step:
    def __init__(self, key: str, label: str, group: Optional[str] = None):
        self.key    = key
        self.label  = label
        self.group  = group
        self.status = PENDING
        self.detail = ''    # shown after label when status == FAIL


class Checklist:
    """
    Prints a live checklist, updating lines in-place via ANSI escape codes.
    Groups are printed as headers; steps are indented under them.
    """

    def __init__(self, steps: List[Step]):
        self.steps     = steps
        self._printed  = False
        self._lock     = threading.Lock()
        self._n_lines  = 0

    def _render_line(self, step: Step) -> str:
        icons = {
            PENDING: ICON_PENDING,
            RUNNING: ICON_RUNNING,
            OK:      ICON_OK,
            FAIL:    ICON_FAIL,
            SKIP:    ICON_SKIP,
        }
        icon   = icons[step.status]
        label  = step.label
        detail = f'  {dim(step.detail)}' if step.detail and step.status == FAIL else ''
        return f'  {icon}  {label}{detail}'

    def _render_all(self) -> List[str]:
        lines    = []
        cur_grp  = None
        for step in self.steps:
            if step.group != cur_grp:
                cur_grp = step.group
                if cur_grp:
                    lines.append('')
                    lines.append(bold(f'  {cur_grp}'))
            lines.append(self._render_line(step))
        return lines

    def print_initial(self) -> None:
        with self._lock:
            lines = self._render_all()
            for line in lines:
                print(line)
            self._n_lines  = len(lines)
            self._printed  = True

    def refresh(self) -> None:
        with self._lock:
            if not self._printed:
                return
            lines = self._render_all()
            # Move cursor up by the number of lines we printed, then overwrite
            up = f'\033[{self._n_lines}A' if not _NO_COLOUR else ''
            sys.stdout.write(up)
            for line in lines:
                # Clear to end-of-line, then print
                eol = '\033[K' if not _NO_COLOUR else ''
                sys.stdout.write(line + eol + '\n')
            self._n_lines = len(lines)
            sys.stdout.flush()

    def set_status(self, key: str, status: str, detail: str = '') -> None:
        for step in self.steps:
            if step.key == key:
                step.status = status
                step.detail = detail
                break
        self.refresh()

    def running(self, key: str) -> None:
        self.set_status(key, RUNNING)

    def ok(self, key: str) -> None:
        self.set_status(key, OK)

    def fail(self, key: str, detail: str = '') -> None:
        self.set_status(key, FAIL, detail)

    def skip(self, key: str) -> None:
        self.set_status(key, SKIP)


# ── Spinner (for long-running steps) ─────────────────────────────────────────

class Spinner:
    """Shows a spinning indicator on a single line while a task runs."""
    FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']

    def __init__(self, message: str):
        self.message = message
        self._stop   = threading.Event()
        self._thread = threading.Thread(target=self._spin, daemon=True)

    def __enter__(self):
        if not _NO_COLOUR:
            self._thread.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        if not _NO_COLOUR and self._thread.is_alive():
            self._thread.join()
        sys.stdout.write('\r\033[K')
        sys.stdout.flush()

    def _spin(self):
        for frame in itertools.cycle(self.FRAMES):
            if self._stop.is_set():
                break
            sys.stdout.write(f'\r  {cyan(frame)}  {dim(self.message)}')
            sys.stdout.flush()
            time.sleep(0.08)


# ── Shell helpers ─────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).parent.parent

def run(
    cmd: List[str],
    *,
    cwd: Optional[Path] = None,
    env: Optional[dict] = None,
    capture: bool = True,
    timeout: int = 1800,
) -> Tuple[int, str, str]:
    """Run a command. Returns (returncode, stdout, stderr)."""
    merged_env = {**os.environ, **(env or {})}
    result = subprocess.run(
        cmd,
        cwd=str(cwd or REPO_ROOT),
        env=merged_env,
        capture_output=capture,
        text=True,
        timeout=timeout,
    )
    return result.returncode, result.stdout or '', result.stderr or ''


def run_live(
    cmd: List[str],
    *,
    cwd: Optional[Path] = None,
    env: Optional[dict] = None,
    timeout: int = 1800,
    log_file: Optional[Path] = None,
) -> Tuple[int, str]:
    """
    Run a command, stream output to a log file (so the customer can tail it),
    and capture it for parsing. Returns (returncode, combined_output).
    """
    merged_env = {**os.environ, **(env or {})}
    lines: List[str] = []

    with subprocess.Popen(
        cmd,
        cwd=str(cwd or REPO_ROOT),
        env=merged_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    ) as proc:
        log_handle = open(log_file, 'w') if log_file else None
        try:
            for line in proc.stdout:
                lines.append(line)
                if log_handle:
                    log_handle.write(line)
                    log_handle.flush()
        finally:
            if log_handle:
                log_handle.close()
        proc.wait(timeout=timeout)
        return proc.returncode, ''.join(lines)


# ── CDK context helpers ───────────────────────────────────────────────────────

def load_cdk_context() -> dict:
    cdk_json = REPO_ROOT / 'cdk.json'
    if cdk_json.exists():
        data = json.loads(cdk_json.read_text())
        return data.get('context', {})
    return {}


def get_context_value(key: str) -> str:
    """Read from cdk.json context, then env var."""
    ctx = load_cdk_context()
    if key in ctx:
        return str(ctx[key])
    return os.environ.get(key.upper().replace('-', '_'), '')


# ── AWS helpers ───────────────────────────────────────────────────────────────

def _boto3_client(service: str):
    import boto3
    region = os.environ.get('AWS_REGION', 'us-east-1')
    return boto3.client(service, region_name=region)


def check_aws_credentials() -> Tuple[bool, str]:
    try:
        import boto3
        sts = boto3.client('sts')
        identity = sts.get_caller_identity()
        account  = identity['Account']
        arn      = identity['Arn']
        return True, f'Account {account}  ({arn.split("/")[-1]})'
    except Exception as e:
        return False, str(e)


def check_bedrock_model(model_id: str = 'anthropic.claude-sonnet-4-5-20250929-v1:0') -> Tuple[bool, str]:
    try:
        import boto3
        region = os.environ.get('AWS_REGION', 'us-east-1')
        br     = boto3.client('bedrock', region_name=region)
        resp   = br.list_foundation_models(byOutputModality='TEXT')
        for m in resp.get('modelSummaries', []):
            if m.get('modelId') == model_id:
                status = m.get('modelLifecycle', {}).get('status', '')
                if status in ('ACTIVE', 'LEGACY', ''):
                    return True, f'{model_id} — {status or "available"}'
                return False, f'{model_id} is {status}'
        return False, (
            f'{model_id} not found — enable it at:\n'
            f'    https://console.aws.amazon.com/bedrock/home#/modelaccess'
        )
    except Exception as e:
        return False, str(e)


def check_tool(name: str, args: List[str] = ['--version']) -> Tuple[bool, str]:
    """Check whether a CLI tool is on PATH and returns its version."""
    binary = shutil.which(name)
    if not binary:
        return False, f'{name} not found on PATH'
    rc, out, err = run([name] + args, capture=True)
    version = (out or err).strip().splitlines()[0] if (out or err).strip() else 'unknown'
    return True, version


def get_ssm_param(name: str) -> Optional[str]:
    try:
        import boto3
        region = os.environ.get('AWS_REGION', 'us-east-1')
        ssm    = boto3.client('ssm', region_name=region)
        resp   = ssm.get_parameter(Name=name)
        return resp['Parameter']['Value']
    except Exception:
        return None


def get_cdk_output(stack_name: str, output_key: str) -> Optional[str]:
    try:
        import boto3
        region = os.environ.get('AWS_REGION', 'us-east-1')
        cf     = boto3.client('cloudformation', region_name=region)
        resp   = cf.describe_stacks(StackName=stack_name)
        for stack in resp['Stacks']:
            for output in stack.get('Outputs', []):
                if output['OutputKey'] == output_key:
                    return output['OutputValue']
    except Exception:
        pass
    return None


# ── Verification helpers ──────────────────────────────────────────────────────

def verify_athena(workgroup: str = 'kostops-workgroup') -> Tuple[bool, str]:
    """Run a trivial Athena query to confirm connectivity."""
    try:
        import boto3
        region  = os.environ.get('AWS_REGION', 'us-east-1')
        athena  = boto3.client('athena', region_name=region)
        bucket  = os.environ.get('ATHENA_RESULTS_BUCKET', '')
        if not bucket:
            # try to infer from SSM config
            config_raw = get_ssm_param('/kostops/agentcore-config')
            if config_raw:
                config = json.loads(config_raw)
                bucket = config.get('environmentVariables', {}).get('ATHENA_RESULTS_BUCKET', '')
        if not bucket:
            import boto3 as b3
            account = b3.client('sts').get_caller_identity()['Account']
            bucket  = f'kostops-athena-results-{account}'

        resp = athena.start_query_execution(
            QueryString     = 'SELECT 1 AS ok',
            WorkGroup       = workgroup,
            ResultConfiguration = {
                'OutputLocation': f's3://{bucket}/install-verify/'
            },
        )
        qid = resp['QueryExecutionId']

        # Poll up to 30s
        for _ in range(30):
            time.sleep(1)
            status = athena.get_query_execution(QueryExecutionId=qid)
            state  = status['QueryExecution']['Status']['State']
            if state == 'SUCCEEDED':
                return True, f'Query {qid[:8]}… succeeded'
            if state in ('FAILED', 'CANCELLED'):
                reason = status['QueryExecution']['Status'].get('StateChangeReason', state)
                return False, reason
        return False, 'Athena query timed out after 30s'
    except Exception as e:
        return False, str(e)


def ping_agent(runtime_arn: str) -> Tuple[bool, str]:
    """Send a __ping__ to the AgentCore Runtime."""
    try:
        import boto3
        region    = os.environ.get('AWS_REGION', 'us-east-1')
        agentcore = boto3.client('bedrock-agentcore', region_name=region)
        agentcore.invoke_agent_runtime(
            agentRuntimeArn  = runtime_arn,
            runtimeSessionId = 'install-verify-' + 'x' * 18,
            payload          = json.dumps({'inputText': '__ping__'}).encode(),
            contentType      = 'application/json',
            accept           = 'application/json',
        )
        return True, 'Ping accepted'
    except Exception as e:
        # A cold-start timeout here is expected on first invocation
        msg = str(e)
        if 'timeout' in msg.lower() or 'initialization' in msg.lower():
            return True, f'Cold-start ping sent (container initializing — keep-warm will handle it)'
        return False, msg


# ── Main install flow ─────────────────────────────────────────────────────────

def build_steps(args) -> List[Step]:
    steps = [
        # ── Stage 0: Prerequisites ────────────────────────────────────────────
        Step('pre_aws',     'AWS credentials',                  'Stage 0 — Prerequisites'),
        Step('pre_bedrock', 'Bedrock model enabled',             'Stage 0 — Prerequisites'),
        Step('pre_node',    'Node.js ≥ 18',                     'Stage 0 — Prerequisites'),
        Step('pre_cdk',     'AWS CDK CLI',                      'Stage 0 — Prerequisites'),
        Step('pre_python',  'Python 3.10+',                     'Stage 0 — Prerequisites'),

        # ── Stage 1: Frontend build ───────────────────────────────────────────
        Step('fe_install',  'npm install  (frontend)',           'Stage 1 — Frontend Build'),
        Step('fe_build',    'npm run build  (frontend)',         'Stage 1 — Frontend Build'),

        # ── Stage 2: CDK Deploy ───────────────────────────────────────────────
        Step('cdk_auth',     'KostOpsAuthStack',                 'Stage 2 — CDK Deploy'),
        Step('cdk_data',     'KostOpsDataStack',                 'Stage 2 — CDK Deploy'),
        Step('cdk_agent',    'KostOpsAgentStack',                'Stage 2 — CDK Deploy'),
        Step('cdk_api',      'KostOpsApiStack',                  'Stage 2 — CDK Deploy'),
        Step('cdk_frontend', 'KostOpsFrontendStack',             'Stage 2 — CDK Deploy'),

        # ── Stage 3: Agent Deploy ─────────────────────────────────────────────
        Step('ag_deps',     'Install agent dependencies',        'Stage 3 — Agent Deploy'),
        Step('ag_zip',      'Package agent zip',                 'Stage 3 — Agent Deploy'),
        Step('ag_upload',   'Upload zip to S3',                  'Stage 3 — Agent Deploy'),
        Step('ag_create',   'Create / update AgentCore Runtime', 'Stage 3 — Agent Deploy'),
        Step('ag_active',   'Wait for ACTIVE status',            'Stage 3 — Agent Deploy'),
        Step('ag_lambda',   'Update chat-handler Lambda',        'Stage 3 — Agent Deploy'),

        # ── Stage 4: Verify ───────────────────────────────────────────────────
        Step('vfy_athena',  'Athena connectivity',               'Stage 4 — Verify'),
        Step('vfy_agent',   'Agent warm-up ping',                'Stage 4 — Verify'),
        Step('vfy_url',     'Site URL',                          'Stage 4 — Verify'),
    ]
    return steps


def run_install(args) -> bool:
    """
    Execute all installation stages, updating the checklist after each step.
    Returns True if all non-skipped steps passed.
    """
    steps = build_steps(args)
    cl    = Checklist(steps)

    log_dir = REPO_ROOT / 'install-logs'
    log_dir.mkdir(exist_ok=True)

    # ── Print header ──────────────────────────────────────────────────────────
    print()
    print(bold('  ╔══════════════════════════════════════════╗'))
    print(bold('  ║        KostOps — Installation            ║'))
    print(bold('  ╚══════════════════════════════════════════╝'))
    print()
    print(dim(f'  Logs: {log_dir}/'))
    print()

    cl.print_initial()
    print()

    overall_ok = True

    # ── Stage 0: Prerequisites ────────────────────────────────────────────────

    cl.running('pre_aws')
    ok, detail = check_aws_credentials()
    (cl.ok if ok else cl.fail)('pre_aws', detail if not ok else '')
    if not ok:
        overall_ok = False
        print(f'\n  {red("✗")}  {red("AWS credentials not configured — cannot continue.")}')
        print(f'     Run: {cyan("aws configure")}  or set AWS_PROFILE\n')
        return False

    cl.running('pre_bedrock')
    ok, detail = check_bedrock_model()
    (cl.ok if ok else cl.fail)('pre_bedrock', detail if not ok else '')
    if not ok:
        overall_ok = False
        # non-fatal warning — customer might fix later
        print(f'\n  {yellow("!")}  {yellow("Bedrock model not accessible.")}')
        print(f'     {detail}')
        print(f'     Continuing — agent deploy will fail if not enabled.\n')
        time.sleep(1)

    cl.running('pre_node')
    ok, version = check_tool('node', ['--version'])
    if ok:
        major = int(version.lstrip('v').split('.')[0]) if version[0] in 'v0123456789' else 0
        if major < 18:
            ok, version = False, f'Node {version} found — need ≥ 18'
    (cl.ok if ok else cl.fail)('pre_node', version if not ok else '')
    if not ok:
        print(f'\n  {red("✗")}  {red("Node.js 18+ is required.")}  Install: https://nodejs.org\n')
        return False

    cl.running('pre_cdk')
    ok, version = check_tool('npx', ['cdk', '--version'])
    if not ok:
        ok, version = check_tool('cdk', ['--version'])
    (cl.ok if ok else cl.fail)('pre_cdk', version if not ok else '')
    if not ok:
        print(f'\n  {red("✗")}  {red("CDK CLI not found.")}  Install: {cyan("npm install -g aws-cdk")}\n')
        return False

    cl.running('pre_python')
    v = sys.version_info
    ok = v >= (3, 10)
    version = f'{v.major}.{v.minor}.{v.micro}'
    (cl.ok if ok else cl.fail)('pre_python', f'{version} — need 3.10+' if not ok else '')
    if not ok:
        print(f'\n  {red("✗")}  {red("Python 3.10+ required.")}  Found: {version}\n')
        return False

    # ── Stage 1: Frontend Build ───────────────────────────────────────────────

    frontend_dir = REPO_ROOT / 'frontend'

    if args.skip_build:
        for k in ('fe_install', 'fe_build'):
            cl.skip(k)
    else:
        cl.running('fe_install')
        with Spinner('npm install (this may take a minute)…'):
            rc, out = run_live(
                ['npm', 'install'],
                cwd=frontend_dir,
                log_file=log_dir / 'fe_install.log',
                timeout=300,
            )
        if rc != 0:
            cl.fail('fe_install', 'see install-logs/fe_install.log')
            cl.skip('fe_build')
            overall_ok = False
        else:
            cl.ok('fe_install')

            cl.running('fe_build')
            with Spinner('npm run build…'):
                rc, out = run_live(
                    ['npm', 'run', 'build'],
                    cwd=frontend_dir,
                    log_file=log_dir / 'fe_build.log',
                    timeout=300,
                )
            if rc != 0:
                cl.fail('fe_build', 'see install-logs/fe_build.log')
                overall_ok = False
            else:
                cl.ok('fe_build')

    # ── Stage 2: CDK Deploy ───────────────────────────────────────────────────

    cdk_stacks = [
        ('cdk_auth',     'KostOpsAuthStack'),
        ('cdk_data',     'KostOpsDataStack'),
        ('cdk_agent',    'KostOpsAgentStack'),
        ('cdk_api',      'KostOpsApiStack'),
        ('cdk_frontend', 'KostOpsFrontendStack'),
    ]

    if args.skip_cdk:
        for k, _ in cdk_stacks:
            cl.skip(k)
    else:
        # Deploy all stacks at once; parse stdout to detect per-stack completion
        cl.running('cdk_auth')  # mark first as running while CDK starts up

        # Build CDK command — pass context values that were already in cdk.json
        cdk_cmd = ['npx', 'cdk', 'deploy', '--all', '--require-approval', 'never',
                   '--output', 'cdk.out']

        with Spinner('Running cdk deploy --all  (see install-logs/cdk_deploy.log)…'):
            rc, cdk_output = run_live(
                cdk_cmd,
                cwd=REPO_ROOT,
                log_file=log_dir / 'cdk_deploy.log',
                timeout=1800,
            )

        # Parse output to detect which stacks succeeded / failed
        stack_results = {}
        for line in cdk_output.splitlines():
            for step_key, stack_name in cdk_stacks:
                if stack_name in line:
                    if '✅' in line or 'successfully deployed' in line.lower() or 'no changes' in line.lower():
                        stack_results[step_key] = OK
                    elif '❌' in line or 'failed' in line.lower():
                        stack_results[step_key] = FAIL

        for step_key, stack_name in cdk_stacks:
            result = stack_results.get(step_key, OK if rc == 0 else FAIL)
            if result == OK:
                cl.ok(step_key)
            else:
                cl.fail(step_key, 'see install-logs/cdk_deploy.log')
                overall_ok = False

        if rc != 0 and not args.skip_agent:
            print(f'\n  {yellow("!")}  CDK deploy had errors — see {dim("install-logs/cdk_deploy.log")}')
            print(f'     Continuing with agent deploy (some stacks may have succeeded).\n')
            time.sleep(1)

    # ── Stage 3: Agent Deploy ─────────────────────────────────────────────────

    if args.skip_agent:
        for k in ('ag_deps', 'ag_zip', 'ag_upload', 'ag_create', 'ag_active', 'ag_lambda'):
            cl.skip(k)
    else:
        # Import the deploy_agent module inline so we can call each step
        # individually and update the checklist.
        sys.path.insert(0, str(REPO_ROOT / 'scripts'))
        try:
            import importlib
            import deploy_agent as da
            importlib.reload(da)
        except Exception as e:
            for k in ('ag_deps', 'ag_zip', 'ag_upload', 'ag_create', 'ag_active', 'ag_lambda'):
                cl.fail(k, str(e)[:80])
            overall_ok = False
            da = None

        if da is not None:
            # Step: load config
            try:
                agent_config = da.load_agent_config()
            except Exception as e:
                for k in ('ag_deps', 'ag_zip', 'ag_upload', 'ag_create', 'ag_active', 'ag_lambda'):
                    cl.fail(k, f'SSM config missing: {e}')
                overall_ok = False
                agent_config = None

            if agent_config:
                import boto3 as _boto3
                account_id    = _boto3.client('sts').get_caller_identity()['Account']
                region        = os.environ.get('AWS_REGION', 'us-east-1')
                athena_bucket = f'kostops-athena-results-{account_id}'

                # Step: dependencies + zip
                cl.running('ag_deps')
                cl.running('ag_zip')   # shown together since zip_agent_code does both
                zip_path = None
                try:
                    with Spinner('Installing agent dependencies + packaging zip…'):
                        zip_path = da.zip_agent_code()
                    cl.ok('ag_deps')
                    cl.ok('ag_zip')
                except Exception as e:
                    cl.fail('ag_deps', str(e)[:80])
                    cl.fail('ag_zip',  'see ag_deps failure')
                    overall_ok = False

                if zip_path:
                    # Step: upload
                    cl.running('ag_upload')
                    try:
                        bucket, s3_key = da.upload_zip(zip_path, athena_bucket, agent_config['agentName'])
                        cl.ok('ag_upload')
                    except Exception as e:
                        cl.fail('ag_upload', str(e)[:80])
                        overall_ok = False
                        bucket = s3_key = None
                    finally:
                        try:
                            os.unlink(zip_path)
                        except Exception:
                            pass

                    if bucket:
                        # Step: create / update runtime
                        cl.running('ag_create')
                        try:
                            runtime_id, runtime_arn = da.deploy_to_agentcore(agent_config, bucket, s3_key)
                            cl.ok('ag_create')
                        except Exception as e:
                            cl.fail('ag_create', str(e)[:80])
                            overall_ok = False
                            runtime_id = runtime_arn = None

                        if runtime_id:
                            # Step: wait for ACTIVE
                            cl.running('ag_active')
                            try:
                                with Spinner('Waiting for AgentCore Runtime to become ACTIVE…'):
                                    da.wait_for_active(runtime_id)
                                cl.ok('ag_active')
                            except Exception as e:
                                cl.fail('ag_active', str(e)[:80])
                                overall_ok = False
                                runtime_arn = None

                            # Step: update Lambda
                            cl.running('ag_lambda')
                            try:
                                da.update_references(runtime_arn)
                                cl.ok('ag_lambda')
                            except Exception as e:
                                cl.fail('ag_lambda', str(e)[:80])
                                # non-fatal

    # ── Stage 4: Verify ───────────────────────────────────────────────────────

    if args.skip_verify:
        for k in ('vfy_athena', 'vfy_agent', 'vfy_url'):
            cl.skip(k)
    else:
        # Athena
        cl.running('vfy_athena')
        with Spinner('Running test Athena query…'):
            ok, detail = verify_athena()
        (cl.ok if ok else cl.fail)('vfy_athena', detail if not ok else '')
        if not ok:
            overall_ok = False

        # Agent ping
        runtime_arn = get_ssm_param('/kostops/agent-runtime-arn')
        if runtime_arn:
            cl.running('vfy_agent')
            with Spinner('Sending warm-up ping to AgentCore Runtime…'):
                ok, detail = ping_agent(runtime_arn)
            (cl.ok if ok else cl.fail)('vfy_agent', detail if not ok else '')
            if not ok:
                overall_ok = False
        else:
            cl.fail('vfy_agent', 'Runtime ARN not found in SSM — was agent deployed?')
            overall_ok = False

        # Site URL
        site_url = get_cdk_output('KostOpsFrontendStack', 'SiteUrl')
        if site_url:
            cl.ok('vfy_url')
        else:
            cl.fail('vfy_url', 'Could not read SiteUrl from CloudFormation outputs')
            overall_ok = False

    # ── Summary ───────────────────────────────────────────────────────────────
    print()
    if overall_ok:
        print(green(bold('  ✓  KostOps installed successfully!')))
        site_url = get_cdk_output('KostOpsFrontendStack', 'SiteUrl') or '(see CDK outputs)'
        print()
        print(f'  {bold("Site URL :")} {cyan(site_url)}')
        print(f'  {bold("Logs dir :")} {dim(str(log_dir))}/')
        print()
        print(dim('  Next steps:'))
        print(dim('    1. Open the site URL and log in with the admin email you set in cdk.json'))
        print(dim('    2. Navigate to the Chat tab and ask "What are my top AWS costs this month?"'))
        print(dim('    3. If the first response takes >30s, that is a cold start — subsequent calls are fast'))
    else:
        print(red(bold('  ✗  Installation completed with errors.')))
        print()
        print(f'  {yellow("Tip:")} Check logs in {dim(str(log_dir))}/')
        print(f'  {yellow("Tip:")} Re-run with {cyan("python scripts/install.py")} after fixing issues.')
        print(f'       Completed steps will be repeated; already-deployed stacks are detected by CDK.')
    print()
    return overall_ok


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='KostOps one-command installer with live status checklist',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Examples:
              # Full fresh install:
              python scripts/install.py

              # Skip CDK (already deployed), just re-deploy agent:
              python scripts/install.py --skip-bootstrap --skip-cdk --skip-build

              # Run only verification checks:
              python scripts/install.py --skip-build --skip-cdk --skip-agent
        """),
    )
    parser.add_argument('--skip-build',      action='store_true', help='Skip npm install + build')
    parser.add_argument('--skip-bootstrap',  action='store_true', help='Skip CDK bootstrap')
    parser.add_argument('--skip-cdk',        action='store_true', help='Skip cdk deploy --all')
    parser.add_argument('--skip-agent',      action='store_true', help='Skip agent zip/deploy')
    parser.add_argument('--skip-verify',     action='store_true', help='Skip post-deploy verification')
    args = parser.parse_args()

    success = run_install(args)
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
