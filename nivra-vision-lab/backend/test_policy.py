import unittest

from policy import decide, needs_temporal


class ConsensusPolicyTest(unittest.TestCase):
    def test_one_confident_model_cannot_raise_a_window(self):
        for name in ("fast", "temporal", "visual"):
            scores = {"fast": .1, "temporal": .1, "visual": .1}
            scores[name] = .99
            self.assertFalse(decide(scores)["aboveThreshold"])

    def test_each_pair_can_confirm_a_window(self):
        for scores in ({"fast": .6, "temporal": .8, "visual": .1},
                       {"fast": .6, "temporal": None, "visual": .95},
                       {"fast": .1, "temporal": .8, "visual": .95}):
            self.assertTrue(decide(scores)["aboveThreshold"])

    def test_skipping_third_model_cannot_change_majority_decision(self):
        for fast in (.1, .4, .8):
            for visual in (.1, .9, .99):
                for temporal in (.1, .7, .9):
                    full = {"fast": fast, "visual": visual, "temporal": temporal}
                    cascade = {**full, "temporal": temporal if needs_temporal(fast, visual) else None}
                    self.assertEqual(decide(full)["aboveThreshold"], decide(cascade)["aboveThreshold"])

    def test_rejects_nonfinite_or_out_of_range_scores(self):
        for value in (float("nan"), float("inf"), -1, 1.1):
            with self.assertRaises(ValueError):
                decide({"fast": value, "temporal": .8, "visual": .99})
