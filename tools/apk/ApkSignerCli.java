import com.android.apksig.ApkSignerEngine;
import com.android.apksig.ApkVerifier;
import com.android.apksig.DefaultApkSignerEngine;
import com.android.apksig.apk.ApkUtils;
import com.android.apksig.util.DataSource;
import com.android.apksig.util.DataSources;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Adds an APK Signature Scheme v2 signature to an APK that already carries a JAR (v1) signature,
 * then verifies the result. Used by tools/apk/build-apk.sh together with the JDK's jarsigner
 * (which produces the v1 signature).
 *
 * Why not simply ApkSigner.sign()? apksig 2.3.0 - the newest release on Maven Central - implements
 * v1 signing on top of JDK-internal classes (sun.security.pkcs.PKCS7#encodeSignedData) that no longer
 * exist on JDK 17+, and when v1 signing is disabled it strips existing META-INF signature files
 * (setOtherSignersSignaturesPreserved is "not yet implemented" in that version). So this tool drives
 * the public DefaultApkSignerEngine API directly for v2 only and splices the signing block into a
 * byte-exact copy of the input zip, which also keeps the 4-byte alignment of stored entries intact.
 *
 * Usage: java [--add-exports ...] -cp apksig.jar:<dir> ApkSignerCli <v1-signed.apk> <out.apk> <keystore> <storepass> <alias> <keypass>
 */
public final class ApkSignerCli {

    public static void main(String[] args) throws Exception {
        if (args.length != 6) {
            System.err.println("usage: ApkSignerCli <v1-signed.apk> <out.apk> <keystore> <storepass> <alias> <keypass>");
            System.exit(64);
        }
        File inputApk = new File(args[0]);
        File outputApk = new File(args[1]);
        File keystoreFile = new File(args[2]);
        char[] storePass = args[3].toCharArray();
        String alias = args[4];
        char[] keyPass = args[5].toCharArray();

        // The default type (PKCS12 on modern JDKs) also transparently loads legacy JKS files.
        KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
        try (InputStream in = new FileInputStream(keystoreFile)) {
            keyStore.load(in, storePass);
        }
        PrivateKey key = (PrivateKey) keyStore.getKey(alias, keyPass);
        if (key == null) {
            throw new IllegalArgumentException("no private key for alias '" + alias + "' in " + keystoreFile);
        }
        Certificate[] chain = keyStore.getCertificateChain(alias);
        if (chain == null || chain.length == 0) {
            throw new IllegalArgumentException("no certificate chain for alias '" + alias + "' in " + keystoreFile);
        }
        List<X509Certificate> certs = new ArrayList<>();
        for (Certificate c : chain) {
            certs.add((X509Certificate) c);
        }

        // minSdkVersion comes from the binary AndroidManifest.xml inside the APK: an independent
        // check that the manifest produced by axml.py is parseable by apksig as well.
        int minSdk;
        try (ZipFile zip = new ZipFile(inputApk)) {
            ZipEntry manifestEntry = zip.getEntry("AndroidManifest.xml");
            if (manifestEntry == null) {
                throw new IllegalArgumentException("AndroidManifest.xml missing from " + inputApk);
            }
            if (zip.getEntry("META-INF/MANIFEST.MF") == null) {
                throw new IllegalArgumentException(inputApk + " has no JAR (v1) signature; run jarsigner first");
            }
            try (InputStream in = zip.getInputStream(manifestEntry)) {
                minSdk = ApkUtils.getMinSdkVersionFromBinaryAndroidManifest(ByteBuffer.wrap(in.readAllBytes()));
            }
        }
        System.out.println("apksig: minSdkVersion from binary AndroidManifest.xml = " + minSdk);

        DefaultApkSignerEngine.SignerConfig signerConfig =
                new DefaultApkSignerEngine.SignerConfig.Builder("CERT", key, certs).build();
        try (ApkSignerEngine engine = new DefaultApkSignerEngine.Builder(Collections.singletonList(signerConfig), minSdk)
                .setV1SigningEnabled(false)
                .setV2SigningEnabled(true)
                .setCreatedBy("cs-android sdkless pipeline (apksig)")
                .build();
             RandomAccessFile raf = new RandomAccessFile(inputApk, "r");
             FileOutputStream out = new FileOutputStream(outputApk)) {

            DataSource apk = DataSources.asDataSource(raf);
            ApkUtils.ZipSections sections = ApkUtils.findZipSections(apk);
            long cdOffset = sections.getZipCentralDirectoryOffset();
            long cdSize = sections.getZipCentralDirectorySizeBytes();
            long eocdOffset = sections.getZipEndOfCentralDirectoryOffset();
            if (cdOffset + cdSize != eocdOffset) {
                throw new IllegalStateException("unexpected zip layout: central directory does not end at the EOCD");
            }
            DataSource zipEntries = apk.slice(0, cdOffset);
            DataSource centralDir = apk.slice(cdOffset, cdSize);
            // The EOCD handed to the engine must point at the spot where the signing block will be
            // inserted (= the current central directory offset), which it already does.
            ByteBuffer eocd = ByteBuffer.allocate((int) (apk.size() - eocdOffset)).order(ByteOrder.LITTLE_ENDIAN);
            apk.copyTo(eocdOffset, eocd.capacity(), eocd);
            eocd.flip();

            ApkSignerEngine.OutputApkSigningBlockRequest request =
                    engine.outputZipSections(zipEntries, centralDir, DataSources.asDataSource(eocd.duplicate()));
            if (request == null) {
                throw new IllegalStateException("engine produced no APK Signing Block");
            }
            byte[] signingBlock = request.getApkSigningBlock();

            FileChannel channel = out.getChannel();
            raf.getChannel().transferTo(0, cdOffset, channel);
            channel.write(ByteBuffer.wrap(signingBlock));
            raf.getChannel().transferTo(cdOffset, cdSize, channel);
            ByteBuffer newEocd = ByteBuffer.allocate(eocd.remaining()).order(ByteOrder.LITTLE_ENDIAN);
            newEocd.put(eocd.duplicate());
            newEocd.flip();
            ApkUtils.setZipEocdCentralDirectoryOffset(newEocd, cdOffset + signingBlock.length);
            channel.write(newEocd);
            request.done();
            engine.outputDone();
            System.out.println("apksig: inserted APK Signing Block (" + signingBlock.length + " bytes, v2, signer CERT, "
                    + key.getAlgorithm() + " " + certs.size() + " cert(s)) -> " + outputApk);
        }

        // ApkVerifier mimics the platform: from Android N on, a v2 signature makes it skip the JAR
        // signature entirely, so v1 is checked in a second pass pinned to API 23 (which ignores v2).
        boolean ok = true;
        ApkVerifier.Result modern = verify(new ApkVerifier.Builder(outputApk).build(), "API " + minSdk + "+");
        ok &= modern.isVerified() && modern.isVerifiedUsingV2Scheme();
        ApkVerifier.Result legacy = verify(new ApkVerifier.Builder(outputApk)
                .setMinCheckedPlatformVersion(23).setMaxCheckedPlatformVersion(23).build(), "API 23 (v1 only)");
        ok &= legacy.isVerified() && legacy.isVerifiedUsingV1Scheme();
        if (!ok) {
            System.err.println("apksig: signature verification FAILED");
            System.exit(2);
        }
        System.out.println("apksig: OK - v1 (JAR) and v2 (APK Signature Scheme v2) signatures verified");
    }

    private static ApkVerifier.Result verify(ApkVerifier verifier, String label) throws Exception {
        ApkVerifier.Result result = verifier.verify();
        for (ApkVerifier.IssueWithParams w : result.getWarnings()) {
            System.out.println("apksig: warning [" + label + "]: " + w);
        }
        for (ApkVerifier.IssueWithParams e : result.getErrors()) {
            System.err.println("apksig: error [" + label + "]: " + e);
        }
        for (ApkVerifier.Result.V1SchemeSignerInfo s : result.getV1SchemeSigners()) {
            for (ApkVerifier.IssueWithParams e : s.getErrors()) {
                System.err.println("apksig: v1 signer error [" + label + "]: " + e);
            }
        }
        for (ApkVerifier.Result.V2SchemeSignerInfo s : result.getV2SchemeSigners()) {
            for (ApkVerifier.IssueWithParams e : s.getErrors()) {
                System.err.println("apksig: v2 signer error [" + label + "]: " + e);
            }
        }
        System.out.println("apksig: ApkVerifier [" + label + "] verified=" + result.isVerified()
                + " v1=" + result.isVerifiedUsingV1Scheme()
                + " v2=" + result.isVerifiedUsingV2Scheme()
                + " signers=" + result.getSignerCertificates().size());
        return result;
    }
}
