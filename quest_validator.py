# quest_validator.py
import os
import sys
import subprocess
import hashlib
import zipfile
import re
from pathlib import Path

# ============================================================================
# CONFIGURATION
# ============================================================================

TOOLS_DIR = os.path.join(os.path.dirname(__file__), "tools")

AAPT_PATHS = [
    os.path.join(TOOLS_DIR, "aapt.exe"),
    os.path.join(TOOLS_DIR, "aapt2.exe"),
    "aapt.exe",
    "aapt2.exe",
]

# Expanded Quest/VR indicators
VR_INDICATORS = {
    'permissions': [
        'com.oculus.permission.USE_OCULUS',
        'com.oculus.permission.USE_VR_API',
        'com.facebook.permission.USE_VR_API',
        'android.permission.VR_MODE',
        'com.oculus.vr.permission.USE_VR',  # Added
        'com.oculus.permission.OCULUS',     # Added
    ],
    'features': [
        'oculus',
        'vr',
        'virtual_reality',
        'headtracking',
        'vrmode',
        'vr_mode',
        'oculusvr',
        'oculus_tracking',
        'handtracking',  # Quest feature
        'controller',     # Quest controller support
    ],
    'metadata': [
        'com.oculus.vr.mode',
        'com.oculus.vr.supported',
        'com.oculus.android',
    ]
}

# ============================================================================
# AAPT WRAPPER
# ============================================================================

class AAPTWrapper:
    def __init__(self):
        self.aapt_path = self._find_aapt()
        self.use_aapt2 = False
        if self.aapt_path and 'aapt2' in self.aapt_path.lower():
            self.use_aapt2 = True
    
    def _find_aapt(self):
        for path in AAPT_PATHS:
            if os.path.exists(path):
                return path
        return None
    
    def is_available(self):
        if not self.aapt_path:
            return False
        try:
            result = subprocess.run(
                [self.aapt_path, 'version'],
                capture_output=True,
                timeout=5
            )
            return result.returncode == 0
        except:
            return False
    
    def get_apk_info(self, apk_path):
        if not self.is_available():
            return None
        
        try:
            if self.use_aapt2:
                cmd = [self.aapt_path, 'dump', 'manifest', apk_path]
            else:
                cmd = [self.aapt_path, 'dump', 'badging', apk_path]
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                return self._parse_aapt_output(result.stdout)
        except:
            pass
        return None
    
    def _parse_aapt_output(self, output):
        data = {
            'package': '',
            'version_code': 0,
            'version_name': '',
            'min_sdk': 0,
            'target_sdk': 0,
            'permissions': [],
            'features': [],
            'native_libs': [],
            'metadata': []
        }
        
        # Parse package and version
        pkg_match = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", output)
        if pkg_match:
            data['package'] = pkg_match.group(1)
            data['version_code'] = int(pkg_match.group(2))
            data['version_name'] = pkg_match.group(3)
        
        # Parse SDK versions
        sdk_match = re.search(r"sdkVersion:'(\d+)'", output)
        if sdk_match:
            data['min_sdk'] = int(sdk_match.group(1))
        
        target_match = re.search(r"targetSdkVersion:'(\d+)'", output)
        if target_match:
            data['target_sdk'] = int(target_match.group(1))
        
        # Parse permissions
        for perm in re.finditer(r"uses-permission: name='([^']+)'", output):
            data['permissions'].append(perm.group(1))
        
        # Parse features
        for feature in re.finditer(r"uses-feature: name='([^']+)'", output):
            data['features'].append(feature.group(1))
        
        # Parse native libraries
        for lib in re.finditer(r"native-code: '([^']+)'", output):
            data['native_libs'].append(lib.group(1))
        
        # Parse metadata (aapt2 format)
        for meta in re.finditer(r"meta-data: name='([^']+)'", output):
            data['metadata'].append(meta.group(1))
        
        return data

# ============================================================================
# ENHANCED VR DETECTION
# ============================================================================

def is_vr_game(apk_info):
    """Check if APK is a VR/Quest game using multiple indicators"""
    
    score = 0
    reasons = []
    
    # 1. Check permissions (high weight)
    for perm in apk_info.get('permissions', []):
        perm_lower = perm.lower()
        for vr_perm in VR_INDICATORS['permissions']:
            if vr_perm.lower() in perm_lower:
                score += 3
                reasons.append(f"VR permission: {perm}")
                break
    
    # 2. Check features (medium weight)
    for feature in apk_info.get('features', []):
        feature_lower = feature.lower()
        for vr_feature in VR_INDICATORS['features']:
            if vr_feature in feature_lower:
                score += 2
                reasons.append(f"VR feature: {feature}")
                break
    
    # 3. Check metadata (medium weight)
    for meta in apk_info.get('metadata', []):
        meta_lower = meta.lower()
        for vr_meta in VR_INDICATORS['metadata']:
            if vr_meta in meta_lower:
                score += 2
                reasons.append(f"VR metadata: {meta}")
                break
    
    # 4. Check package name (low weight)
    package = apk_info.get('package', '').lower()
    if any(x in package for x in ['vr', 'oculus', 'quest', 'virtualreality']):
        score += 1
        reasons.append(f"VR package name: {package}")
    
    # 5. Check SDK (Quest requires at least SDK 23)
    min_sdk = apk_info.get('min_sdk', 0)
    if min_sdk >= 23:
        score += 1
        reasons.append(f"SDK {min_sdk} >= 23 (Quest compatible)")
    
    # Decision: score >= 3 means it's likely a VR game
    is_vr = score >= 3
    
    return {
        'is_vr': is_vr,
        'score': score,
        'reasons': reasons
    }

# ============================================================================
# FALLBACK VALIDATOR
# ============================================================================

def extract_manifest_text(zip_file):
    """Extract manifest text from APK"""
    try:
        manifest_bytes = zip_file.read('AndroidManifest.xml')
        strings = []
        current = []
        for byte in manifest_bytes:
            if 32 <= byte <= 126:
                current.append(chr(byte))
            else:
                if len(current) >= 3:
                    strings.append(''.join(current))
                current = []
        if len(current) >= 3:
            strings.append(''.join(current))
        return ' '.join(strings)
    except:
        return ""

def validate_without_aapt(file_path):
    result = {
        'file': os.path.basename(file_path),
        'valid': False,
        'package': '',
        'version_code': 0,
        'version_name': '',
        'size_mb': 0,
        'hash': '',
        'min_sdk': 0,
        'permissions': [],
        'features': [],
        'errors': [],
        'warnings': [],
        'vr_score': 0,
        'vr_reasons': []
    }
    
    try:
        size = os.path.getsize(file_path)
        result['size_mb'] = size / (1024 * 1024)
        
        # Calculate hash
        sha256 = hashlib.sha256()
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                sha256.update(chunk)
        result['hash'] = sha256.hexdigest()[:16] + "..."
        
        with open(file_path, 'rb') as f:
            with zipfile.ZipFile(f) as zf:
                if 'AndroidManifest.xml' not in zf.namelist():
                    result['errors'].append("Missing AndroidManifest.xml")
                    return result
                
                manifest_text = extract_manifest_text(zf)
                
                # Extract package
                pkg_match = re.search(r'package="([^"]+)"', manifest_text)
                if pkg_match:
                    result['package'] = pkg_match.group(1)
                
                # Extract version
                vc_match = re.search(r'versionCode="(\d+)"', manifest_text)
                if vc_match:
                    result['version_code'] = int(vc_match.group(1))
                
                vn_match = re.search(r'versionName="([^"]+)"', manifest_text)
                if vn_match:
                    result['version_name'] = vn_match.group(1)
                
                # Extract permissions
                for perm in re.finditer(r'uses-permission[^>]*name="([^"]+)"', manifest_text):
                    result['permissions'].append(perm.group(1))
                
                # Extract features
                for feature in re.finditer(r'uses-feature[^>]*name="([^"]+)"', manifest_text):
                    result['features'].append(feature.group(1))
                
                # Extract min SDK
                sdk_match = re.search(r'minSdkVersion="(\d+)"', manifest_text)
                if sdk_match:
                    result['min_sdk'] = int(sdk_match.group(1))
                
                # Check if it's a VR game
                apk_info = {
                    'package': result['package'],
                    'permissions': result['permissions'],
                    'features': result['features'],
                    'min_sdk': result['min_sdk'],
                    'metadata': []
                }
                
                vr_check = is_vr_game(apk_info)
                result['vr_score'] = vr_check['score']
                result['vr_reasons'] = vr_check['reasons']
                
                if not vr_check['is_vr']:
                    result['errors'].append(f"Not a VR game (score {vr_check['score']}/3 needed)")
                else:
                    # Check SDK warning (not error)
                    if result['min_sdk'] < 23 and result['min_sdk'] > 0:
                        result['warnings'].append(f"Min SDK {result['min_sdk']} < 23 (may not work on Quest)")
                    
                    # Check for native libs
                    libs = [f for f in zf.namelist() if f.startswith('lib/') and f.endswith('.so')]
                    if libs:
                        has_arm64 = any('arm64' in lib for lib in libs)
                        if not has_arm64:
                            result['warnings'].append("Missing arm64 native libraries (may affect performance)")
                
                if not result['errors']:
                    result['valid'] = True
                    
    except zipfile.BadZipFile:
        result['errors'].append("Corrupted or invalid ZIP file")
    except Exception as e:
        result['errors'].append(f"Error: {str(e)}")
    
    return result

# ============================================================================
# MAIN VALIDATION
# ============================================================================

def validate_apk(file_path, aapt):
    result = {
        'file': os.path.basename(file_path),
        'valid': False,
        'package': '',
        'version_code': 0,
        'version_name': '',
        'size_mb': 0,
        'hash': '',
        'min_sdk': 0,
        'target_sdk': 0,
        'permissions': [],
        'features': [],
        'native_libs': [],
        'metadata': [],
        'errors': [],
        'warnings': [],
        'vr_score': 0,
        'vr_reasons': []
    }
    
    # Get file size
    size = os.path.getsize(file_path)
    result['size_mb'] = size / (1024 * 1024)
    
    # Calculate hash
    sha256 = hashlib.sha256()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            sha256.update(chunk)
    result['hash'] = sha256.hexdigest()[:16] + "..."
    
    # Try with aapt first
    if aapt.is_available():
        info = aapt.get_apk_info(file_path)
        if info:
            result['package'] = info['package']
            result['version_code'] = info['version_code']
            result['version_name'] = info['version_name']
            result['min_sdk'] = info['min_sdk']
            result['target_sdk'] = info['target_sdk']
            result['permissions'] = info['permissions']
            result['features'] = info['features']
            result['native_libs'] = info['native_libs']
            result['metadata'] = info['metadata']
    
    # If aapt failed or not available, try fallback
    if not result['package']:
        fallback = validate_without_aapt(file_path)
        result.update(fallback)
        return result
    
    # Check if it's a VR game
    vr_check = is_vr_game(result)
    result['vr_score'] = vr_check['score']
    result['vr_reasons'] = vr_check['reasons']
    
    if not vr_check['is_vr']:
        result['errors'].append(f"Not a VR game (score {vr_check['score']}/3 needed)")
    else:
        # Check SDK
        if result['min_sdk'] < 23 and result['min_sdk'] > 0:
            result['warnings'].append(f"Min SDK {result['min_sdk']} < 23 (may not work on Quest)")
        
        # Check native libs
        if result['native_libs']:
            has_arm64 = any('arm64-v8a' in lib for lib in result['native_libs'])
            if not has_arm64:
                result['warnings'].append("Missing arm64-v8a native libraries (may affect performance)")
        
        if not result['errors']:
            result['valid'] = True
    
    return result

def scan_directory(directory):
    aapt = AAPTWrapper()
    
    print()
    if aapt.is_available():
        print("[OK] Using aapt: " + aapt.aapt_path)
    else:
        print("[WARN] aapt not found. Using fallback validation")
        print("       Place aapt.exe in 'tools' folder for better results")
    
    # Find all APK files
    apk_files = []
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.lower().endswith('.apk'):
                apk_files.append(os.path.join(root, file))
    
    if not apk_files:
        print("\nNo APK files found in " + directory)
        return
    
    print("\n" + "="*70)
    print("SCANNING: " + directory)
    print("Found " + str(len(apk_files)) + " APK file(s)")
    print("="*70 + "\n")
    
    valid_count = 0
    invalid_count = 0
    valid_files = []
    
    for apk in apk_files:
        result = validate_apk(apk, aapt)
        
        if result['valid']:
            valid_count += 1
            valid_files.append(result)
            print("[VALID] " + result['file'])
            print("        Package: " + result['package'])
            print("        Version: " + result['version_name'] + " (code " + str(result['version_code']) + ")")
            print("        Size: " + "{:.2f}".format(result['size_mb']) + " MB")
            print("        VR Score: " + str(result['vr_score']) + "/3")
            if result['min_sdk'] > 0:
                print("        SDK: min " + str(result['min_sdk']))
            if result['vr_reasons']:
                for reason in result['vr_reasons'][:3]:
                    print("        + " + reason)
            if result['warnings']:
                for warning in result['warnings']:
                    print("        WARN: " + warning)
            print()
        else:
            invalid_count += 1
            print("[INVALID] " + result['file'])
            for error in result['errors']:
                print("        ERROR: " + error)
            if result['vr_reasons']:
                print("        Found VR indicators:")
                for reason in result['vr_reasons'][:3]:
                    print("          - " + reason)
            if result['warnings']:
                for warning in result['warnings']:
                    print("        WARN: " + warning)
            print()
    
    # Summary
    print("="*70)
    print("SUMMARY")
    print("="*70)
    print("Total: " + str(len(apk_files)))
    print("Valid: " + str(valid_count))
    print("Invalid: " + str(invalid_count))
    print("="*70 + "\n")
    
    if valid_count > 0:
        print("Files ready for upload:")
        for game in valid_files:
            print("  * " + game['file'] + " - " + game['package'] + " v" + game['version_name'])
        print()

# ============================================================================
# MAIN
# ============================================================================

def main():
    if len(sys.argv) < 2:
        print("Usage: python quest_validator.py C:\\path\\to\\directory")
        print("Example: python quest_validator.py C:\\Users\\name\\Downloads\\apks")
        sys.exit(1)
    
    directory = sys.argv[1]
    
    if not os.path.exists(directory):
        print("Directory not found: " + directory)
        sys.exit(1)
    
    scan_directory(directory)

if __name__ == "__main__":
    main()