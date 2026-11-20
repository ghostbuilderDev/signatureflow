import importlib.util,json,shutil,subprocess,tempfile,unittest,sys
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('sf3installer',HERE/'jdc/install.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
SOURCE=Path(sys.argv.pop(1)).resolve() if len(sys.argv)>1 else Path.home()/'Journal-de-chantier-SNCF'
class InstallerTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.repo=self.root/'repo';shutil.copytree(SOURCE,self.repo)
 def tearDown(self):self.temp.cleanup()
 def git(self,*args):return subprocess.run(['git','-C',str(self.repo),*args],check=True,capture_output=True,text=True).stdout.strip()
 def test_preserves_existing_assets_and_adds_verified_bridge(self):
  plan=mod.make_plan(self.repo);before=json.loads((self.repo/'release-lock-v16.1.57.json').read_text());after=json.loads(plan[mod.NEW_LOCK]);old={mod.file_path(self.repo,r['url'])[1] for r in before['files']};new={mod.file_path(self.repo,r['url'])[1] for r in after['files']}
  self.assertEqual(new-old,{'signatureflow-document-ui-v3.js','signatureflow-bridge-v3.js','signatureflow-document-v3.css'});self.assertIn(b'JDC_PHOTO_FIT_V16155_JS',plan['index.html']);self.assertIn(b'JDC_BULK_DOCUMENTS_V16157',plan['app-v13.js'])
  for name,data in plan.items():(self.repo/name).write_bytes(data)
  self.assertTrue(mod.integrity(self.repo,after))
 def test_incompatible_or_tampered_installation_writes_nothing(self):
  (self.repo/'app-v13.js').write_bytes(b'changed')
  with self.assertRaises(mod.RepairError):mod.make_plan(self.repo)
  self.assertFalse((self.repo/mod.NEW_LOCK).exists())
 def test_newer_major_version_is_not_downgraded(self):
  channel=json.loads((self.repo/'release-channel.json').read_text());channel['version']='16.3.0';(self.repo/'release-channel.json').write_text(json.dumps(channel))
  with self.assertRaisesRegex(mod.RepairError,'retour'):mod.make_plan(self.repo)
 def test_backup_and_repeated_apply_are_exact(self):
  self.git('init','-b','main');self.git('config','user.name','Fixture');self.git('config','user.email','fixture@example.invalid');self.git('remote','add','origin','https://github.com/ghostbuilderdev/Journal-de-chantier-SNCF.git');self.git('add','.');self.git('commit','-m','baseline');original=(self.repo/'app-v13.js').read_bytes()
  with patch.object(Path,'home',return_value=self.root/'private'):
   mod.apply(self.repo,False);state=mod.read_json(mod.state_path(self.repo));self.assertEqual((Path(state['backup'])/'app-v13.js').read_bytes(),original);self.assertTrue((Path(state['backup'])/'historique-avant-signatureflow.bundle').is_file());after=(self.repo/'app-v13.js').read_bytes();mod.apply(self.repo,False);self.assertEqual((self.repo/'app-v13.js').read_bytes(),after)
if __name__=='__main__':unittest.main(verbosity=2)
