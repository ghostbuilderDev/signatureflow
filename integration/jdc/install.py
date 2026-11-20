#!/usr/bin/env python3
"""JDC 16.2.0 — SignatureFlow intégré, avec sauvegarde et manifeste complet."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, urlencode
from urllib.request import Request, urlopen

VERSION = '16.2.0'
BASE_VERSION = '16.1.58'
RELEASE = '16.2.0-signatureflow-documents'
SITE = 'https://ghostbuilderdev.github.io/Journal-de-chantier-SNCF/'
HERE = Path(__file__).resolve().parent
INDEX_MARKER = 'JDC_SIGNATUREFLOW_V3'
NEW_LOCK = 'release-lock-v16.2.0.json'
PAGE = 'signatureflow-document-v3.css'


class RepairError(Exception):
    pass


def fail(message):
    raise RepairError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def jsonbytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def git(repo, *args, check=True):
    p = subprocess.run(['git', '-C', str(repo), *args], text=True,
                       encoding='utf-8', errors='replace', capture_output=True)
    if check and p.returncode:
        if 'Author identity unknown' in p.stderr or 'unable to auto-detect email' in p.stderr:
            fail('Identité Git non configurée (nom/e-mail). Correctif conservé ; configure Git puis relance la même commande.')
        # Git may include authentication URLs: do not echo them into a report.
        fail('Git : échec de « ' + ' '.join(args[:2]) + ' ». ' +
             'Vérifie la connexion et ton accès GitHub dans Termux. Aucun écrasement forcé.')
    return p


def read_json(path):
    return json.loads(path.read_text('utf-8'))


def file_path(repo, url):
    parsed = urlsplit(url)
    if parsed.scheme or parsed.netloc or parsed.fragment:
        fail('URL extérieure dans le manifeste : arrêt.')
    name = parsed.path.removeprefix('./')
    if not name or name.startswith('/') or '..' in PurePosixPath(name).parts or '%' in name:
        fail('Chemin invalide dans le manifeste : arrêt.')
    path = repo / name
    if not path.resolve().is_relative_to(repo.resolve()):
        fail('Chemin sortant du dépôt : arrêt.')
    return path, name


def replace_once(text, pattern, replacement, label):
    text, count = re.subn(pattern, lambda m: replacement, text, count=1)
    if count != 1:
        fail('Structure non reconnue : ' + label + '. Aucun fichier modifié.')
    return text


def integrity(repo, lock):
    errors = []
    urls = set()
    paths = set()
    for row in lock.get('files', []):
        url = row.get('url', '')
        if url in urls or not re.fullmatch(r'[a-f0-9]{64}', row.get('sha256', '')):
            fail('Entrée du manifeste invalide ou en double.')
        urls.add(url)
        path, name = file_path(repo, url)
        paths.add(name)
        if not path.is_file():
            errors.append(name + ' (absent)')
            continue
        data = path.read_bytes()
        if sha(data) == row['sha256']:
            continue
        errors.append(name + ' (empreinte différente)')
    needed = {'index.html', 'app-v13.js', 'jdc-update-manager.js', 'service-worker-v13.js',
              'config.js', 'supabase.js', 'cr-off.js', 'styles-v13.css'}
    if not needed.issubset(paths):
        fail('Manifeste incomplet : fichiers essentiels manquants.')
    if errors:
        fail('Fichiers incompatibles avec le manifeste : ' + ', '.join(errors[:8]) +
             (f' (+{len(errors)-8})' if len(errors) > 8 else '') + '. Aucun fichier réécrit.')
    return True


def channel(repo):
    p = repo / 'release-channel.json'
    if not p.is_file():
        fail('release-channel.json absent. Le dépôt complet est nécessaire.')
    value = read_json(p)
    if value.get('schema') != 'jdc-release-channel-v1':
        fail('Canal de version non reconnu.')
    return value


def make_plan(repo):
    current = channel(repo)
    base = current.get('version', '')
    if not re.fullmatch(r'16\.1\.(?:5[7-9]|[6-9][0-9]|[1-9][0-9]{2,})',base):
        fail('Socle attendu : JDC 16.1.57 ou ultérieur dans la série 16.1. Aucun retour arrière. Version : '+base)
    old_lock = read_json(repo / ('release-lock-v'+base+'.json'))
    if old_lock.get('release') != current.get('release'): fail('Canal et manifeste différents.')
    integrity(repo,old_lock)
    index=(repo/'index.html').read_text('utf-8')
    app=(repo/'app-v13.js').read_text('utf-8')
    if INDEX_MARKER in index or INDEX_MARKER in app: fail('Intégration partielle déjà présente ; aucun écrasement.')
    for fn in ('currentChantier','canManageDocuments','isCloudReady','refreshCloudCurrent'):
        if not re.search(r'function\s+'+fn+r'\s*\(',app):fail('Interface JDC incompatible : '+fn)
    hook=(HERE/'hook.js').read_text('utf-8')
    marker='  initialize().catch('
    if app.count(marker)!=1: fail('Point de démarrage JDC non reconnu.')
    app=app.replace(marker,hook+'\n'+marker)
    app=replace_once(app,r'const APP_VERSION\s*=\s*["\x27][^"\x27]+["\x27]','const APP_VERSION = "16.2.0"','version applicative')
    for name in ('app-v13.js','jdc-update-manager.js'):
        pattern=r'(src=["\x27](?:\./)?'+re.escape(name)+r')\?[^"\x27]*'
        index,n=re.subn(pattern,lambda m:m[1]+'?v='+VERSION,index)
        if n!=1:fail('Référence de script non reconnue : '+name)
    pattern=r'(<script\s+src=["\x27](?:\./)?app-v13\.js[^>]*>)'
    index,n=re.subn(pattern,'<!-- '+INDEX_MARKER+' -->\n<script src="signatureflow-document-ui-v3.js?v=16.2.0" defer></script>\n<script src="signatureflow-bridge-v3.js?v=16.2.0" defer></script>\n'+r'\1',index)
    if n!=1:fail('Point de chargement JDC non reconnu.')
    index=replace_once(index,r'</head\s*>','<link rel="stylesheet" href="signatureflow-document-v3.css?v=16.2.0">\n</head>','fin head')
    manager=replace_once((repo/'jdc-update-manager.js').read_text('utf-8'),r"const VERSION='[^']+'","const VERSION='16.2.0'",'gestionnaire')
    worker=(repo/'service-worker-v13.js').read_text('utf-8')
    worker=replace_once(worker,r"const RELEASE_ID = '[^']+';",f"const RELEASE_ID = '{RELEASE}';",'worker ID')
    worker=replace_once(worker,r"const RELEASE_VERSION = '[^']+';",f"const RELEASE_VERSION = '{VERSION}';",'worker version')
    worker=replace_once(worker,r"const LOCK_PATH = '[^']+';",f"const LOCK_PATH = './{NEW_LOCK}?v={VERSION}';",'worker lock')
    files={'index.html':index.encode(),'app-v13.js':app.encode(),'jdc-update-manager.js':manager.encode(),
      'signatureflow-document-ui-v3.js':(HERE.parent/'document-flow-ui.js').read_bytes(),
      'signatureflow-bridge-v3.js':(HERE/'signatureflow-bridge.js').read_bytes(),
      PAGE:(HERE.parent/'document-flow.css').read_bytes()}
    additions=['signatureflow-document-ui-v3.js','signatureflow-bridge-v3.js',PAGE]
    core=re.search(r'const CORE_REPAIR_ASSETS=(\[[^;]+\]);',worker)
    if not core:fail('Ressources du worker non reconnues.')
    priority=list(dict.fromkeys(json.loads(core[1])+additions))
    worker=worker[:core.start(1)]+json.dumps(priority,separators=(',',':'))+worker[core.end(1):]
    rows=[]
    for original in old_lock['files']:
        _,name=file_path(repo,original['url']);row=dict(original)
        if name in additions:fail('Fichier SignatureFlow déjà présent dans le manifeste.')
        if name in files or name=='service-worker-v13.js':row['url']='./'+name+'?v='+VERSION
        rows.append(row)
    rows += [{'url':'./'+name+'?v='+VERSION} for name in additions]
    worker=replace_once(worker,r'const RELEASE_FILE_COUNT = \d+;',f'const RELEASE_FILE_COUNT = {len(rows)};','nombre de ressources')
    files['service-worker-v13.js']=worker.encode()
    for row in rows:
        _,name=file_path(repo,row['url'])
        if name in files:row.update(sha256=sha(files[name]),bytes=len(files[name]))
    now=datetime.now(timezone.utc).isoformat()
    files[NEW_LOCK]=jsonbytes(dict(old_lock,release=RELEASE,created_at=now,files=rows))
    files['release-channel.json']=jsonbytes(dict(current,version=VERSION,release=RELEASE,published_at=now))
    if not shutil.which('node'):fail('Node.js requis : pkg install -y nodejs')
    for name,data in files.items():
        if name.endswith('.js'):
            if subprocess.run(['node','--check'],input=data,capture_output=True).returncode:fail('JavaScript invalide : '+name)
    print(f'Intégration prête depuis {base} : {len(rows)} ressources vérifiées.')
    return files


def get_public(name):
    req = Request(SITE + name + ('&' if '?' in name else '?') + urlencode({'jdc_verify': time.time_ns()}),
                  headers={'Cache-Control': 'no-cache', 'User-Agent': 'JDC-Termux-Update/16.2.0'})
    with urlopen(req, timeout=15) as response:
        return response.read()


def print_check(repo):
    print('\n=== CONTRÔLE JDC ===', flush=True)
    c = channel(repo)
    print('Version du dépôt :', c.get('version'))
    print('Publication :', c.get('release'))
    print('Commit local :', git(repo, 'rev-parse', '--short', 'HEAD').stdout.strip())
    print('Branche :', git(repo, 'branch', '--show-current').stdout.strip())
    lock = read_json(repo / ('release-lock-v' + c['version'] + '.json'))
    try:
        integrity(repo, lock)
        print('Intégrité : OK')
    except RepairError as e:
        print('Intégrité :', e)
    app = (repo / 'app-v13.js').read_text('utf-8')
    m = re.search(r'const APP_VERSION\s*=\s*[\"\x27]([^\"\x27]+)', app)
    print('Version affichée par le code :', m[1] if m else 'inconnue')
    print('SignatureFlow intégré :', 'PRÉSENT' if INDEX_MARKER in (repo / 'index.html').read_text('utf-8') else 'ABSENT')
    status = git(repo, 'status', '--porcelain').stdout
    print('Fichiers locaux :', 'modifications en attente' if status.strip() else 'propres')
    counts = git(repo, 'rev-list', '--left-right', '--count', 'HEAD...origin/main', check=False)
    if counts.returncode == 0:
        ahead, behind = counts.stdout.split()
        print('Comparaison au dernier état GitHub connu :', ahead, 'commit(s) local(aux) non publié(s),', behind, 'commit(s) de retard')
    try:
        public = json.loads(get_public('release-channel.json'))
        print('Version annoncée sur le site :', public.get('version'))
        data = get_public('index.html')
        expected = json.loads(get_public('release-lock-v' + public['version'] + '.json'))
        row = next(r for r in expected['files'] if urlsplit(r['url']).path.removeprefix('./') == 'index.html')
        print('Empreinte accueil publié :', 'OK' if sha(data) == row['sha256'] else 'DIVERGENTE — mise à jour PWA bloquée')
    except Exception:
        print('Site : contrôle réseau non confirmé ; aucun diagnostic inventé.')
    print('La version active du téléphone se vérifie dans la PWA, pas depuis Termux.\n', flush=True)


def verify_repo(repo):
    if not (repo / '.git').exists() or not (repo / 'index.html').is_file():
        fail('Dépôt introuvable : ' + str(repo) + '. Utilise --repo CHEMIN si nécessaire.')
    if git(repo, 'branch', '--show-current').stdout.strip() != 'main':
        fail('La branche attendue est main. Aucune branche changée automatiquement.')
    origin = git(repo, 'remote', 'get-url', 'origin').stdout.strip()
    if not re.fullmatch(r'(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)ghostbuilderdev/Journal-de-chantier-SNCF(?:\.git)?/?', origin, re.I):
        fail('Dépôt distant différent du Journal de chantier attendu.')


def state_path(repo):
    return Path.home() / '.jdc-signatureflow-16200' / (sha(str(repo).encode())[:12] + '.json')


def state_matches(repo, state):
    return state.get('repo') == str(repo) and all(
        (repo / n).is_file() and sha((repo / n).read_bytes()) == h
        for n, h in state.get('after', {}).items()) and bool(state.get('after'))


def verify_published(files, attempts=16):
    # A pushed commit is not proof that GitHub Pages has finished deploying it.
    for attempt in range(attempts):
        try:
            c = json.loads(get_public('release-channel.json'))
            if c.get('release') != RELEASE:
                raise RepairError('ancienne publication encore servie')
            # Verify the exact generated bytes, not just a version label.
            for name, data in files.items():
                if sha(get_public(name)) != sha(data):
                    raise RepairError('fichiers de publication encore en cours')
            print('SITE PUBLIÉ V16.2.0 : octets des fichiers modifiés et manifeste vérifiés.', flush=True)
            return True
        except Exception:
            print(f'GitHub Pages : publication non encore confirmée ({attempt+1}/{attempts}).', flush=True)
            if attempt + 1 < attempts:
                time.sleep(10)
    print('Commit envoyé, mais publication Pages non confirmée. Ne considère pas la PWA à jour.')
    return False


def apply(repo, push):
    verify_repo(repo)
    sp = state_path(repo)
    state = read_json(sp) if sp.exists() else {}
    status = git(repo, 'status', '--porcelain', '-z').stdout
    head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
    resumed = state_matches(repo, state) and head in {state.get('base'), state.get('commit')}
    if resumed:
        dirty = {item[3:] for item in status.split('\0') if item}
        if not dirty.issubset(set(state['after'])):
            fail('Autres modifications locales présentes ; elles sont conservées. Publication arrêtée.')
        files = {name: (repo / name).read_bytes() for name in state['after']}
        print('Reprise du correctif préparé précédemment ; aucune nouvelle copie.')
    else:
        if status.strip():
            fail('Modifications locales en cours. Aucun fichier écrasé. Lance --check et transmets le résultat pour une reprise ciblée.')
        if push:
            git(repo, 'fetch', '--quiet', 'origin', 'main')
            remote = git(repo, 'rev-parse', 'refs/remotes/origin/main').stdout.strip()
            if head != remote:
                if git(repo, 'merge-base', '--is-ancestor', head, remote, check=False).returncode == 0:
                    git(repo, 'merge', '--ff-only', 'refs/remotes/origin/main')
                    head = remote
                    print('Dépôt synchronisé avec GitHub (avance simple).')
                else:
                    fail('Des commits locaux ne sont pas sur GitHub. Aucun push forcé. Lance --check pour le diagnostic.')
        if channel(repo).get('release') == RELEASE:
            lock = read_json(repo / NEW_LOCK)
            integrity(repo, lock)
            print('V16.2.0 déjà présente et cohérente ; aucun doublon.')
            files = {n: (repo / n).read_bytes() for n in
                     ('index.html','app-v13.js','jdc-update-manager.js','service-worker-v13.js',NEW_LOCK,'release-channel.json',PAGE,'signatureflow-document-ui-v3.js','signatureflow-bridge-v3.js')}
            if push and not verify_published(files):
                fail('Publication JDC non confirmée. Relance la même commande pour vérifier.')
            return
        files = make_plan(repo)
        collision = [n for n in (NEW_LOCK, PAGE) if (repo / n).exists()]
        if collision:
            fail('Un fichier de cette réparation existe déjà : ' + ', '.join(collision))
        backup = Path.home() / 'jdc-sauvegardes' / ('signatureflow-v16200-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
        backup.mkdir(parents=True)
        git(repo,'bundle','create',str(backup/'historique-avant-signatureflow.bundle'),'--all')
        existing = []
        for name in files:
            if (repo / name).exists():
                (backup / name).write_bytes((repo / name).read_bytes())
                existing.append(name)
        state = {'repo': str(repo), 'base': head, 'commit': None, 'backup': str(backup),
                 'existing': existing, 'after': {n: sha(b) for n, b in files.items()}}
        sp.parent.mkdir(parents=True, exist_ok=True)
        sp.write_bytes(jsonbytes(state))
        try:
            for name, data in files.items():
                (repo / name).write_bytes(data)
            integrity(repo, read_json(repo / NEW_LOCK))
        except Exception:
            for name in files:
                if name in existing:
                    (repo / name).write_bytes((backup / name).read_bytes())
                else:
                    (repo / name).unlink(missing_ok=True)
            fail('Écriture interrompue : fichiers applicatifs restaurés depuis la sauvegarde.')
        print('Sauvegarde :', backup, flush=True)
        print('Mise à jour locale V16.2.0 vérifiée.', flush=True)
    if not push:
        print('Publication non demandée. Relance avec --apply --push pour publier.')
        return
    git(repo, 'fetch', '--quiet', 'origin', 'main')
    remote = git(repo, 'rev-parse', 'refs/remotes/origin/main').stdout.strip()
    if remote not in {state['base'], state.get('commit')}:
        fail('GitHub a changé depuis la préparation. Correctif local conservé, aucun écrasement distant.')
    if head == state['base']:
        git(repo, 'add', '--', *files)
        staged = set(git(repo, 'diff', '--cached', '--name-only').stdout.splitlines())
        if staged != set(files):
            fail('Liste des fichiers préparés inattendue. Aucun commit réalisé.')
        git(repo, 'commit', '-m', 'feat(documents): SignatureFlow intégré v16.2.0')
        state['commit'] = git(repo, 'rev-parse', 'HEAD').stdout.strip()
        sp.write_bytes(jsonbytes(state))
    git(repo, 'push', 'origin', 'HEAD:refs/heads/main')
    print('Commit envoyé sur GitHub :', git(repo, 'rev-parse', '--short', 'HEAD').stdout.strip(), flush=True)
    if not verify_published(files):
        fail('Publication JDC non confirmée. Relance la même commande pour vérifier.')
    print('\nOuvre JDC, puis « Mettre à jour » quand le bandeau apparaît.')
    print('Enregistre les saisies ouvertes ; ferme ensuite toutes les fenêtres JDC et rouvre l’application.')
    print('Version attendue dans les paramètres : 16.2.0.')
    print('Documents de chantier > Signatures et prises de connaissance. Active d’abord le backend SignatureFlow 3.')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo', type=Path, default=Path.home() / 'Journal-de-chantier-SNCF')
    p.add_argument('--check', action='store_true', help='versions et intégrité, sans modification du dépôt')
    p.add_argument('--apply', action='store_true', help='réparer localement avec sauvegarde')
    p.add_argument('--push', action='store_true', help='publier le correctif sur main, sans force')
    args = p.parse_args()
    repo = args.repo.expanduser().resolve()
    try:
        verify_repo(repo)
        if args.check or not args.apply:
            print_check(repo)
        if args.push and not args.apply:
            fail('--push doit être accompagné de --apply.')
        if args.apply:
            apply(repo, args.push)
    except (RepairError, OSError, ValueError, KeyError, StopIteration) as e:
        print('\nARRÊT : ' + str(e), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
