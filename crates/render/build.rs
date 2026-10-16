// Compiles the Slang shaders to SPIR-V with slangc (tools/slang/bin/slangc, or $SLANGC).
use std::{env, path::PathBuf, process::Command};

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let shaders = root.join("shaders");
    let slangc = env::var("SLANGC").map(PathBuf::from).unwrap_or_else(|_| root.join("tools/slang/bin/slangc"));
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    println!("cargo:rerun-if-changed={}", shaders.display());
    println!("cargo:rerun-if-env-changed=SLANGC");
    // (file, entry point, stage, output)
    let jobs = [
        ("raymarch", "main", "compute", "raymarch"),
        ("bake", "main", "compute", "bake"),
        ("ui", "vsMain", "vertex", "ui.vert"),
        ("ui", "fsMain", "fragment", "ui.frag"),
    ];
    for (name, entry, stage, output) in jobs {
        let src = shaders.join(format!("{name}.slang"));
        let spv = out.join(format!("{output}.spv"));
        let status = Command::new(&slangc)
            .arg(&src)
            .arg("-I")
            .arg(&shaders)
            .args(["-target", "spirv", "-entry", entry, "-stage", stage, "-matrix-layout-column-major", "-O2", "-o"])
            .arg(&spv)
            .status()
            .unwrap_or_else(|e| panic!("cannot run {} ({e}); install Slang in tools/slang or set SLANGC", slangc.display()));
        assert!(status.success(), "slangc failed on {} ({entry})", src.display());
    }
}
