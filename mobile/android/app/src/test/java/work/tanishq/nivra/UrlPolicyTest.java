package work.tanishq.nivra;

import org.junit.Test;
import static org.junit.Assert.*;

public class UrlPolicyTest {
    private final String token = "aB_1234567890123456789012345678901234567890-x";

    @Test public void cameraAndGuardLinksPreservePairingFragment() {
        for (String role : new String[]{"camera", "guard"}) {
            String expected = UrlPolicy.ORIGIN + "/" + role + "#pair=" + token;
            assertEquals(expected, UrlPolicy.pairing(expected));
            assertEquals(expected, UrlPolicy.pairing("nivra://" + role + "#pair=" + token));
        }
    }
    @Test public void rejectsForeignOriginsAndAmbiguousLinks() {
        for (String value : new String[]{
            "http://nivra.tanishq.work/camera#pair=" + token,
            "https://nivra.tanishq.work.evil.test/camera#pair=" + token,
            "https://evil.test@nivra.tanishq.work/camera#pair=" + token,
            "https://nivra.tanishq.work:8443/camera#pair=" + token,
            "https://nivra.tanishq.work/camera?redirect=evil#pair=" + token,
            "https://nivra.tanishq.work/%63amera#pair=" + token,
            "nivra://camera/path#pair=" + token,
            "nivra://camera#pair=" + token + "&role=admin",
            "nivra://guard#pair=short"}) {
            assertNull(value, UrlPolicy.pairing(value));
        }
    }
    @Test public void neverKeepsCredentialsInResumeUrl() {
        assertEquals(UrlPolicy.ORIGIN + "/guard", UrlPolicy.withoutFragment(UrlPolicy.ORIGIN + "/guard#pair=" + token));
    }
    @Test public void ownerInvitationsAcceptLegacyAndNativeWallLinks() {
        assertEquals(UrlPolicy.ORIGIN + "/wall#operator=" + token,
            UrlPolicy.pairing("nivra://wall#operator=" + token));
        assertEquals(UrlPolicy.ORIGIN + "/#operator=" + token,
            UrlPolicy.pairing(UrlPolicy.ORIGIN + "/#operator=" + token));
        assertNull(UrlPolicy.pairing("nivra://camera#operator=" + token));
    }
}
