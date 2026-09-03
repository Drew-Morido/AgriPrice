# model/keras_compat.py — Keras 3.x save/load compatibility shims
"""
Some .keras artifacts in the repo were saved with a newer Keras build that
serializes GlorotUniform with ``input_axes`` / ``output_axes`` in get_config().
Older runtimes (e.g. Keras 3.14 bundled with TF 2.20) reject those keys on
load. Patch deserialization once before tf.keras.models.load_model().
"""

_PATCHED = False


def apply_keras_load_compat() -> None:
    """Idempotent patch so saved LSTM models load across minor Keras versions."""
    global _PATCHED
    if _PATCHED:
        return

    from keras.initializers import GlorotUniform

    _orig_from_config = GlorotUniform.from_config.__func__
    _strip = ("input_axes", "output_axes")

    @classmethod
    def _from_config(cls, config):
        cfg = dict(config)
        for key in _strip:
            cfg.pop(key, None)
        return _orig_from_config(cls, cfg)

    GlorotUniform.from_config = _from_config
    _PATCHED = True
